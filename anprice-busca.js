"use strict";

// ======================================================
// ANPRICE - BUSCA INTELIGENTE 2.0
// ------------------------------------------------------
// Estrategia por camadas:
//   1. Intencao: classifica a pesquisa (generica x especifica)
//      e descobre dominio/categoria pelo domain_discovery.
//   2. Catalogo: /products/search filtrado pelo dominio
//      principal, com paginacao controlada.
//   3. Sinal de mercado: ranking de mais vendidos da categoria
//      (highlights). Produtos do ranking que correspondem a
//      pesquisa entram como candidatos e recebem a posicao.
//   4. Refinamento: modelos/linhas extraidos dos atributos.
//      Em pesquisas genericas, os modelos mais recentes sao
//      pesquisados automaticamente.
//   5. Selecao: pontuacao explicavel, deduplicacao de variantes
//      e detalhe (/products/{id}) apenas quando falta imagem.
//
// Nada aqui inventa preco, comissao ou link de oferta.
// Cache em memoria e orcamento de chamadas por requisicao
// protegem os limites da API (HTTP 429).
// ======================================================

const TTL_PADRAO = 10 * 60 * 1000;
const TTL_DETALHE = 30 * 60 * 1000;
const CACHE_MAX = 600;
const POR_PAGINA = 30;
const ORCAMENTO_CHAMADAS = 50;
const CONCORRENCIA = 3;

// Palavras que, quando aparecem no titulo mas NAO na pesquisa,
// indicam acessorio, peca ou item de exposicao.
const TERMOS_ACESSORIO = [
  "capa", "capinha", "case", "pelicula", "protetor", "suporte",
  "carregador", "cabo", "adaptador", "manequim", "expositor",
  "cabide", "refil", "adesivo", "skin", "bolsa", "estojo",
  "peca", "pecas", "reparo", "replica", "vitrine", "mostruario",
  "caixa vazia", "somente caixa", "molde"
];

const UNIDADES = new Set([
  "gb", "tb", "mb", "mah", "w", "v", "ml", "l", "g", "kg", "cm",
  "mm", "m", "pol", "polegadas", "hz", "x", "un", "unid",
  "unidades", "pcs", "pecas", "metros", "litros"
]);

const ATRIBUTOS_EXIBIR = [
  "BRAND", "LINE", "MODEL", "INTERNAL_MEMORY", "RAM", "COLOR",
  "MAIN_COLOR", "SIZE", "GENDER", "MATERIAL", "FRAGRANCE_NAME",
  "VOLUME", "UNITS_PER_PACK"
];

function normalizar(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(texto) {
  return normalizar(texto).split(" ").filter(x => x.length > 0);
}

function slugPesquisa(texto) {
  return normalizar(texto).replace(/\s+/g, "-").slice(0, 80);
}

function linkPesquisaPublica(texto) {
  const slug = slugPesquisa(texto);
  return slug ? `https://lista.mercadolivre.com.br/${slug}` : null;
}

// Extrai "geracao" de nomes como "iPhone 15", "Galaxy S23",
// ignorando capacidades (128 GB) e medidas.
function geracaoDoNome(nome) {
  const t = tokens(nome);
  let maior = null;
  for (let i = 0; i < t.length; i++) {
    const m = /^([a-z]{0,2})(\d{1,2})([a-z]?)$/.exec(t[i]);
    if (!m) continue;
    if (UNIDADES.has(t[i + 1] || "")) continue;
    const n = Number(m[2]);
    if (n > 0 && (maior === null || n > maior)) maior = n;
  }
  return maior;
}

function atributo(produto, id) {
  const a = Array.isArray(produto?.attributes)
    ? produto.attributes.find(x => x.id === id)
    : null;
  const v = a?.value_name ?? a?.values?.[0]?.name ?? null;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function anoCriacao(produto) {
  const d = Date.parse(produto?.date_created || "");
  return Number.isFinite(d) ? new Date(d).getUTCFullYear() : null;
}

function analisarIntencao(q) {
  const lista = tokens(q).filter(x => x.length > 1 || /\d/.test(x));
  const numericos = lista.filter(x => /\d/.test(x));
  const acessorioNaPesquisa = TERMOS_ACESSORIO.filter(termo =>
    (" " + normalizar(q) + " ").includes(" " + termo + " ")
  );
  return {
    texto: q,
    normalizado: normalizar(q),
    palavras: lista,
    palavrasModelo: numericos,
    generica: lista.length <= 2 && numericos.length === 0,
    buscaAcessorio: acessorioNaPesquisa.length > 0
  };
}

// ------------------------------------------------------
// Cache simples (LRU aproximado) compartilhado entre buscas
// ------------------------------------------------------
const cache = new Map();

function chaveCache(caminho, params) {
  const p = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${caminho}?${p}`;
}

function lerCache(chave) {
  const c = cache.get(chave);
  if (!c) return null;
  if (c.expira < Date.now()) {
    cache.delete(chave);
    return null;
  }
  cache.delete(chave);
  cache.set(chave, c);
  return c.valor;
}

function gravarCache(chave, valor, ttl) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(chave, { valor, expira: Date.now() + ttl });
}

function registrarBuscaInteligente(app, deps) {
  const {
    mlGet,
    exigirAdmin,
    rotaSegura,
    erroML,
    resumoProduto,
    limiteValido
  } = deps;

  function novoContexto() {
    return {
      chamadasApi: 0,
      cacheHits: 0,
      orcamento: ORCAMENTO_CHAMADAS,
      bloqueado429: false,
      retryAfter: null,
      problemas: []
    };
  }

  // Toda chamada passa por aqui: cache, orcamento e 429.
  async function consultar(ctx, caminho, params = {}, ttl = TTL_PADRAO) {
    const chave = chaveCache(caminho, params);
    const emCache = lerCache(chave);
    if (emCache) {
      ctx.cacheHits++;
      return emCache;
    }
    if (ctx.bloqueado429) {
      return { ok: false, status: 429, dados: {}, pulado: true };
    }
    if (ctx.chamadasApi >= ctx.orcamento) {
      return { ok: false, status: 0, dados: {}, orcamentoEsgotado: true };
    }
    ctx.chamadasApi++;
    let r;
    try {
      r = await mlGet(caminho, params);
    } catch (e) {
      ctx.problemas.push({ caminho, motivo: e.name || "erro" });
      return { ok: false, status: 0, dados: {} };
    }
    if (r.status === 429) {
      ctx.bloqueado429 = true;
      ctx.retryAfter = r.retryAfter ?? null;
    }
    if (r.ok) gravarCache(chave, r, ttl);
    return r;
  }

  async function emLotes(itens, funcao) {
    const saida = [];
    for (let i = 0; i < itens.length; i += CONCORRENCIA) {
      const lote = itens.slice(i, i + CONCORRENCIA);
      saida.push(...(await Promise.all(lote.map(funcao))));
    }
    return saida;
  }

  // ----------------------------------------------------
  // Camada 1: dominio e categoria
  // ----------------------------------------------------
  async function descobrirDominio(ctx, q) {
    const r = await consultar(
      ctx,
      "/sites/MLB/domain_discovery/search",
      { q, limit: 5 }
    );
    if (!r.ok || !Array.isArray(r.dados)) {
      return { sugestoes: [], erro: r.status || "indisponivel" };
    }
    const vistos = new Set();
    const sugestoes = [];
    for (const x of r.dados) {
      if (!x.domain_id || vistos.has(x.domain_id)) continue;
      vistos.add(x.domain_id);
      sugestoes.push({
        dominioId: x.domain_id,
        dominio: x.domain_name ?? null,
        categoriaId: x.category_id ?? null,
        categoria: x.category_name ?? null
      });
    }
    return { sugestoes, erro: null };
  }

  // ----------------------------------------------------
  // Camada 2: catalogo paginado
  // ----------------------------------------------------
  async function pesquisarCatalogo(ctx, consulta, dominio, paginas) {
    const resultados = [];
    let total = null;
    let filtroDominioAplicado = Boolean(dominio);
    let erroPrimeira = null;

    for (let pagina = 0; pagina < paginas; pagina++) {
      const params = {
        site_id: "MLB",
        status: "active",
        q: consulta,
        limit: POR_PAGINA,
        offset: pagina * POR_PAGINA
      };
      if (filtroDominioAplicado) params.domain_id = dominio;

      let r = await consultar(ctx, "/products/search", params);

      // Se o filtro de dominio for recusado ou zerar os resultados,
      // repete sem ele (o dominio continua sendo checado no codigo).
      const vazio =
        r.ok && pagina === 0 &&
        (!Array.isArray(r.dados?.results) || r.dados.results.length === 0);
      if (
        pagina === 0 && filtroDominioAplicado &&
        ((!r.ok && r.status !== 429 && r.status !== 0) || vazio)
      ) {
        filtroDominioAplicado = false;
        delete params.domain_id;
        r = await consultar(ctx, "/products/search", params);
      }

      if (!r.ok) {
        if (pagina === 0) erroPrimeira = r;
        break;
      }

      const lista = Array.isArray(r.dados?.results) ? r.dados.results : [];
      if (total === null) total = r.dados?.paging?.total ?? null;
      resultados.push(...lista);

      const fim =
        lista.length < POR_PAGINA ||
        (total !== null && (pagina + 1) * POR_PAGINA >= total);
      if (fim) break;
    }

    return { resultados, total, filtroDominioAplicado, erroPrimeira };
  }

  // ----------------------------------------------------
  // Camada 3: ranking de mais vendidos (sinal de mercado)
  // ----------------------------------------------------
  async function consultarRanking(ctx, categoriaId) {
    if (!categoriaId || !/^MLB\d+$/.test(categoriaId)) return [];
    const r = await consultar(
      ctx,
      `/highlights/MLB/category/${categoriaId}`,
      {},
      TTL_PADRAO
    );
    if (!r.ok || !Array.isArray(r.dados?.content)) return [];
    return r.dados.content
      .filter(x => x && x.id)
      .map(x => ({
        id: x.id,
        tipo: x.type ?? null,
        posicao: x.position ?? null
      }));
  }

  async function detalheProduto(ctx, id) {
    if (!/^MLB\d+$/.test(id)) return null;
    const r = await consultar(ctx, `/products/${id}`, {}, TTL_DETALHE);
    return r.ok ? r.dados : null;
  }

  // ----------------------------------------------------
  // Pontuacao explicavel
  // ----------------------------------------------------
  function avaliar(raw, intencao, contexto) {
    const nome = raw.name || "";
    const texto = " " + normalizar(nome) + " ";
    const palavrasNome = new Set(texto.trim().split(" "));
    let pontos = 0;
    const motivos = [];
    const alertas = [];

    let encontradas = 0;
    for (const p of intencao.palavras) {
      if (palavrasNome.has(p)) {
        pontos += 3;
        encontradas++;
      } else if (texto.includes(p)) {
        pontos += 1;
        encontradas += 0.5;
      }
    }
    if (intencao.palavras.length && encontradas >= intencao.palavras.length) {
      pontos += 4;
      motivos.push("Contém todas as palavras pesquisadas");
    }
    if (
      intencao.palavras.length >= 2 &&
      texto.includes(" " + intencao.normalizado + " ")
    ) {
      pontos += 5;
      motivos.push("Nome corresponde exatamente à pesquisa");
    }

    // Numero de modelo pedido (ex.: "15", "s23") precisa existir.
    for (const m of intencao.palavrasModelo) {
      if (!palavrasNome.has(m)) {
        pontos -= 6;
        alertas.push(`Modelo "${m}" não aparece no nome`);
      }
    }

    // Acessorios e itens de exposicao.
    if (!intencao.buscaAcessorio) {
      const achado = TERMOS_ACESSORIO.find(t => texto.includes(" " + t + " "));
      if (achado) {
        pontos -= 8;
        alertas.push(`Parece acessório/item relacionado ("${achado}")`);
      }
      const primeira = intencao.palavras[0];
      if (primeira && texto.includes(" para " + primeira)) {
        pontos -= 6;
        alertas.push("Item “para” o produto pesquisado");
      }
    }

    // Dominio.
    const dominio = raw.domain_id || null;
    let dominioConfirmado = null;
    if (contexto.dominioPrincipal) {
      if (dominio === contexto.dominioPrincipal) {
        pontos += 6;
        dominioConfirmado = true;
        motivos.push(`Categoria confirmada (${dominio.replace(/^MLB-/, "")})`);
      } else if (dominio && contexto.dominiosRelacionados.has(dominio)) {
        pontos += 1;
        dominioConfirmado = false;
      } else if (dominio) {
        pontos -= 4;
        dominioConfirmado = false;
      }
    }

    if (Array.isArray(raw.pictures) && raw.pictures.length) pontos += 1;

    // Sinal de mercado: posicao no ranking da categoria.
    const posicao = contexto.posicoesRanking.get(raw.id) ?? null;
    if (posicao !== null) {
      pontos += Math.max(2, 8 - Math.floor(posicao / 3));
      motivos.push(`${posicao}º entre os mais vendidos da categoria`);
    }

    // Recencia: so pesa em pesquisas genericas (ex.: "iPhone").
    const geracao = geracaoDoNome(nome);
    const ano = anoCriacao(raw);
    if (intencao.generica) {
      if (geracao !== null && contexto.maiorGeracao) {
        const bonus = Math.round((geracao / contexto.maiorGeracao) * 5);
        pontos += bonus;
        if (bonus >= 4) motivos.push("Entre os modelos mais recentes encontrados");
      } else if (ano !== null) {
        pontos += Math.max(0, Math.min(3, Math.floor((ano - 2018) / 2)));
      }
    }

    return { pontos, motivos, alertas, dominioConfirmado, posicao, geracao };
  }

  // ----------------------------------------------------
  // Refinamentos (modelos, linhas, marcas)
  // ----------------------------------------------------
  function montarRefinamentos(candidatos, intencao) {
    const mapa = new Map();
    const adicionar = (rotulo, consulta, tipo) => {
      const chave = normalizar(consulta);
      if (!chave || chave === intencao.normalizado) return;
      if (chave.length < 2 || chave.length > 60) return;
      const atual = mapa.get(chave) || {
        rotulo, consulta, tipo, quantidade: 0,
        geracao: geracaoDoNome(rotulo)
      };
      atual.quantidade++;
      mapa.set(chave, atual);
    };

    for (const c of candidatos) {
      const modelo = atributo(c, "MODEL");
      const linha = atributo(c, "LINE");
      const marca = atributo(c, "BRAND");
      const contemPesquisa = v =>
        intencao.palavras.some(p => normalizar(v).split(" ").includes(p));

      if (modelo && contemPesquisa(modelo)) {
        adicionar(modelo, modelo, "modelo");
      } else if (modelo && linha && contemPesquisa(linha)) {
        adicionar(`${linha} ${modelo}`, `${linha} ${modelo}`, "modelo");
      }
      if (linha && contemPesquisa(linha) && normalizar(linha) !== intencao.normalizado) {
        adicionar(linha, linha, "linha");
      }
      if (marca && !contemPesquisa(marca)) {
        adicionar(marca, `${intencao.texto} ${marca}`, "marca");
      }
    }

    // Marca so ajuda a refinar quando ha mais de uma marca.
    const marcas = [...mapa.values()].filter(r => r.tipo === "marca");
    if (marcas.length < 2) {
      for (const [k, r] of mapa) if (r.tipo === "marca") mapa.delete(k);
    }

    return [...mapa.values()]
      .sort((a, b) =>
        (b.tipo === "modelo") - (a.tipo === "modelo") ||
        (b.geracao ?? -1) - (a.geracao ?? -1) ||
        b.quantidade - a.quantidade
      )
      .slice(0, 10);
  }

  function atributosPrincipais(raw) {
    const saida = [];
    for (const id of ATRIBUTOS_EXIBIR) {
      const v = atributo(raw, id);
      if (v && v.length <= 40 && !saida.some(x => x.valor === v)) {
        const a = raw.attributes.find(x => x.id === id);
        saida.push({ id, nome: a?.name ?? id, valor: v });
      }
      if (saida.length >= 5) break;
    }
    return saida;
  }

  // ====================================================
  // ROTA
  // ====================================================
  app.get(
    "/api/ml/busca-inteligente",
    exigirAdmin,
    rotaSegura(async (req, res) => {
      res.set("Cache-Control", "no-store");
      const inicio = Date.now();

      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const limite = limiteValido(req.query.limite ?? "10", 20);
      const paginas = limiteValido(req.query.paginas ?? "2", 3) || 2;
      const explorar = req.query.explorar !== "0";
      const dominioForcado =
        typeof req.query.dominio === "string" &&
        /^MLB-[A-Z0-9_]{2,60}$/.test(req.query.dominio)
          ? req.query.dominio
          : null;

      if (q.length < 2 || q.length > 100) {
        return res.status(400).json({
          sucesso: false,
          erro: "Informe uma pesquisa entre 2 e 100 caracteres"
        });
      }
      if (!limite) {
        return res.status(400).json({
          sucesso: false,
          erro: "O limite deve estar entre 1 e 20"
        });
      }

      const ctx = novoContexto();
      const intencao = analisarIntencao(q);
      const camadas = [];

      // ---- Camada 1
      const descoberta = await descobrirDominio(ctx, q);
      const principal =
        (dominioForcado &&
          descoberta.sugestoes.find(s => s.dominioId === dominioForcado)) ||
        (dominioForcado ? { dominioId: dominioForcado } : null) ||
        descoberta.sugestoes[0] ||
        null;

      const contexto = {
        dominioPrincipal: principal?.dominioId ?? null,
        dominiosRelacionados: new Set(
          descoberta.sugestoes.map(s => s.dominioId)
        ),
        posicoesRanking: new Map(),
        maiorGeracao: null
      };

      // ---- Camada 2
      const candidatos = new Map();
      const origem = new Map();
      const adicionarCandidatos = (lista, nomeCamada) => {
        let novos = 0;
        for (const c of lista) {
          if (!c || !c.id || !c.name) continue;
          if (!candidatos.has(c.id)) {
            candidatos.set(c.id, c);
            origem.set(c.id, nomeCamada);
            novos++;
          }
        }
        return novos;
      };

      const catalogo = await pesquisarCatalogo(
        ctx, q, contexto.dominioPrincipal, paginas
      );
      if (catalogo.erroPrimeira && catalogo.resultados.length === 0) {
        return erroML(res, catalogo.erroPrimeira, "busca_inteligente_catalogo");
      }
      camadas.push({
        camada: "catalogo",
        consulta: q,
        filtroDominio: catalogo.filtroDominioAplicado
          ? contexto.dominioPrincipal
          : null,
        recebidos: catalogo.resultados.length,
        novos: adicionarCandidatos(catalogo.resultados, "catalogo")
      });

      // ---- Camada 3: ranking da categoria
      if (explorar && principal?.categoriaId) {
        const ranking = await consultarRanking(ctx, principal.categoriaId);
        for (const x of ranking) {
          if (x.posicao !== null) contexto.posicoesRanking.set(x.id, x.posicao);
        }
        // Em pesquisas genericas, busca os produtos do ranking que
        // ainda nao estao entre os candidatos (podem ser os recentes).
        const faltantes = intencao.generica
          ? ranking
              .filter(x => x.tipo === "PRODUCT" && !candidatos.has(x.id))
              .sort((a, b) => (a.posicao ?? 999) - (b.posicao ?? 999))
              .slice(0, 12)
          : [];
        const detalhados = (
          await emLotes(faltantes, x => detalheProduto(ctx, x.id))
        ).filter(Boolean);
        const relevantes = detalhados.filter(d => {
          const t = new Set(tokens(d.name));
          return intencao.palavras.every(p => t.has(p) || normalizar(d.name).includes(p));
        });
        camadas.push({
          camada: "ranking_categoria",
          categoria: principal.categoriaId,
          itensRanking: ranking.length,
          detalhados: detalhados.length,
          novos: adicionarCandidatos(relevantes, "ranking")
        });
      }

      // ---- Camada 4: refinamentos automaticos
      let refinamentos = montarRefinamentos([...candidatos.values()], intencao);
      if (explorar && intencao.generica && !ctx.bloqueado429) {
        const alvo = refinamentos
          .filter(r => r.tipo === "modelo" && r.geracao !== null)
          .slice(0, 3);
        for (const r of alvo) {
          const extra = await pesquisarCatalogo(
            ctx, r.consulta, contexto.dominioPrincipal, 1
          );
          camadas.push({
            camada: "refinamento",
            consulta: r.consulta,
            recebidos: extra.resultados.length,
            novos: adicionarCandidatos(extra.resultados, "refinamento")
          });
        }
        refinamentos = montarRefinamentos([...candidatos.values()], intencao);
      }

      // ---- Camada 5: pontuacao, deduplicacao e selecao
      for (const c of candidatos.values()) {
        const g = geracaoDoNome(c.name);
        if (g !== null && (contexto.maiorGeracao === null || g > contexto.maiorGeracao)) {
          contexto.maiorGeracao = g;
        }
      }

      const avaliados = [...candidatos.values()]
        .map(raw => ({ raw, av: avaliar(raw, intencao, contexto) }))
        .filter(x => x.av.pontos > 0)
        .sort((a, b) => b.av.pontos - a.av.pontos);

      let descartadosDominio = 0;
      const porGrupo = new Map();
      const vistosNome = new Set();
      const principais = [];
      const alternativos = [];

      for (const item of avaliados) {
        const grupo = item.raw.parent_id || item.raw.id;
        const nomeChave = normalizar(item.raw.name);
        if (porGrupo.has(grupo) || vistosNome.has(nomeChave)) {
          const base = porGrupo.get(grupo);
          if (base) base.variantes++;
          continue;
        }
        const entrada = { ...item, variantes: 1 };
        porGrupo.set(grupo, entrada);
        vistosNome.add(nomeChave);

        if (item.av.dominioConfirmado === false) {
          descartadosDominio++;
          alternativos.push(entrada);
        } else {
          principais.push(entrada);
        }
      }

      let selecionados = principais.slice(0, limite);
      let usouAlternativos = false;
      if (selecionados.length === 0 && alternativos.length) {
        selecionados = alternativos.slice(0, limite);
        usouAlternativos = true;
      }

      // Detalhe apenas para quem nao trouxe imagem.
      let consultasDetalhes = 0;
      await emLotes(selecionados, async s => {
        if (Array.isArray(s.raw.pictures) && s.raw.pictures.length) return;
        consultasDetalhes++;
        const d = await detalheProduto(ctx, s.raw.id);
        if (d) s.raw = { ...s.raw, ...d };
      });

      const produtos = selecionados.map(s => {
        const base = resumoProduto(s.raw);
        return {
          ...base,
          pontuacaoRelevancia: s.av.pontos,
          motivos: s.av.motivos,
          alertas: s.av.alertas,
          correspondenciaDominio:
            s.av.dominioConfirmado === false ? "nao_confirmada" :
            s.av.dominioConfirmado === true ? "confirmada" : "sem_classificacao",
          posicaoRanking: s.av.posicao,
          geracaoModelo: s.av.geracao,
          variantesAgrupadas: s.variantes,
          parentId: s.raw.parent_id ?? null,
          atributosPrincipais: atributosPrincipais(s.raw),
          camadaOrigem: origem.get(s.raw.id) ?? null,
          origem: "CATALOGO_MERCADO_LIVRE",
          linkPesquisaOfertas: linkPesquisaPublica(base.titulo || q),
          linkOferta: null,
          comissaoAfiliado: null,
          elegibilidadeAfiliado: "nao_verificada"
        };
      });

      return res.json({
        sucesso: true,
        sistema: "AnPrice",
        recurso: "Busca inteligente",
        versaoBusca: "2.0",

        pesquisa: q,
        site: "MLB",

        intencao: {
          generica: intencao.generica,
          palavras: intencao.palavras,
          palavrasModelo: intencao.palavrasModelo,
          buscaAcessorio: intencao.buscaAcessorio
        },

        classificacao: {
          dominioPrincipal: contexto.dominioPrincipal,
          categoriaPrincipal: principal?.categoriaId ?? null,
          nomeCategoria: principal?.categoria ?? null,
          dominiosIdentificados: descoberta.sugestoes.map(s => s.dominioId),
          sugestoes: descoberta.sugestoes,
          erroClassificacao: descoberta.erro
        },

        totalCatalogo: catalogo.total,
        candidatosAnalisados: candidatos.size,
        consultasDetalhes,
        descartadosDominio,
        usouAlternativos,

        limiteSolicitado: limite,
        totalRetornado: produtos.length,
        resultadoParcial: ctx.bloqueado429,
        retryAfter: ctx.retryAfter,

        refinamentos: refinamentos.map(r => ({
          rotulo: r.rotulo,
          consulta: r.consulta,
          tipo: r.tipo,
          quantidade: r.quantidade
        })),
        linkPesquisaOfertas: linkPesquisaPublica(q),

        produtos,

        camadas,
        consumo: {
          chamadasApi: ctx.chamadasApi,
          respostasDoCache: ctx.cacheHits,
          orcamento: ctx.orcamento,
          duracaoMs: Date.now() - inicio
        },

        diagnostico: {
          problemas: ctx.problemas,
          observacao:
            "Resultados de catalogo nao garantem anuncio disponivel ou elegibilidade de afiliado. Links de pesquisa abrem a busca publica do Mercado Livre e nao sao links de anuncio nem de afiliado."
        },

        consultadoEm: new Date().toISOString()
      });
    })
  );
}

module.exports = {
  registrarBuscaInteligente,
  // exportados para testes
  _interno: { normalizar, geracaoDoNome, analisarIntencao, linkPesquisaPublica }
};
