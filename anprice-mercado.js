"use strict";

// ======================================================
// ANPRICE - INTELIGENCIA DE MERCADO
// ------------------------------------------------------
// Rotas (todas protegidas por exigirAdmin):
//   GET  /api/ml/v2/produto?id=MLB..&categoria=MLB..
//        ficha, ofertas do catalogo, vendedores, tarifas,
//        posicao no ranking, comissao e indicador calculado
//   GET  /api/ml/v2/comparar?ids=MLB1,MLB2&categoria=
//   GET  /api/ml/v2/radar?categoria=MLB..
//        mais vendidos + tendencias de busca da categoria
//   GET  /api/ml/v2/concorrencia
//        anuncios da conta conectada x vencedor do catalogo
//   GET  /api/ml/v2/comissoes      taxas informadas pelo usuario
//   POST /api/ml/v2/comissoes
//   GET  /api/ml/v2/recursos       quais recursos a API libera
//
// Regra: todo dado vem marcado com sua origem. Nada de preco,
// venda ou comissao inventados. Quando a API recusa (403),
// o campo fica indisponivel e o motivo e informado.
// ======================================================

const TTL = 10 * 60 * 1000;
const TTL_LONGO = 60 * 60 * 1000;
const CACHE_MAX = 800;
const cache = new Map();

const ID_PRODUTO = /^MLB\d{3,15}$/;
const ID_CATEGORIA = /^MLB\d{1,12}$/;
const ID_DOMINIO = /^MLB-[A-Z0-9_]{2,60}$/;

function chave(caminho, params) {
  const p = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${caminho}?${p}`;
}

function lerCache(k) {
  const c = cache.get(k);
  if (!c) return null;
  if (c.expira < Date.now()) { cache.delete(k); return null; }
  return c.valor;
}

function gravarCache(k, valor, ttl) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, { valor, expira: Date.now() + ttl });
}

function mediana(lista) {
  if (!lista.length) return null;
  const v = [...lista].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function arred(n, casas = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = 10 ** casas;
  return Math.round(n * f) / f;
}

function valorAtributo(a) {
  const v = a?.value_name ?? a?.values?.[0]?.name ?? null;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function registrarInteligenciaMercado(app, deps) {
  const { mlGet, exigirAdmin, rotaSegura, erroML, conectarMongoDB } = deps;

  function contexto() {
    return { chamadas: 0, cache: 0, limite: 60, bloqueado429: false, retryAfter: null };
  }

  async function consultar(ctx, caminho, params = {}, ttl = TTL) {
    const k = chave(caminho, params);
    const c = lerCache(k);
    if (c) { ctx.cache++; return c; }
    if (ctx.bloqueado429) return { ok: false, status: 429, dados: {}, pulado: true };
    if (ctx.chamadas >= ctx.limite) return { ok: false, status: 0, dados: {}, orcamento: true };
    ctx.chamadas++;
    let r;
    try {
      r = await mlGet(caminho, params);
    } catch (e) {
      return { ok: false, status: 0, dados: {}, erro: e.name };
    }
    if (r.status === 429) { ctx.bloqueado429 = true; ctx.retryAfter = r.retryAfter ?? null; }
    if (r.ok) gravarCache(k, r, ttl);
    return r;
  }

  async function emLotes(itens, fn, n = 3) {
    const out = [];
    for (let i = 0; i < itens.length; i += n) {
      out.push(...(await Promise.all(itens.slice(i, i + n).map(fn))));
    }
    return out;
  }

  function indisponivel(r) {
    return {
      disponivel: false,
      httpMercadoLivre: r?.status || null,
      motivo:
        r?.status === 403 ? "A API do Mercado Livre não libera este dado para esta conta" :
        r?.status === 404 ? "Não encontrado no Mercado Livre" :
        r?.status === 429 ? "Limite de requisições atingido; tente em instantes" :
        r?.orcamento ? "Limite de consultas desta análise atingido" :
        "Consulta indisponível no momento"
    };
  }

  // ---------------- Comissoes (MongoDB) ----------------
  async function colecaoComissoes() {
    const db = await conectarMongoDB();
    return db.collection("anprice_comissoes");
  }

  async function listarComissoes() {
    try {
      const col = await colecaoComissoes();
      return await col.find({}, { projection: { _id: 0 } }).limit(500).toArray();
    } catch {
      return null;
    }
  }

  async function comissaoPara(dominio, categoria) {
    const lista = await listarComissoes();
    if (!lista) return null;
    return (
      lista.find(c => c.chave === dominio) ||
      lista.find(c => c.chave === categoria) ||
      lista.find(c => c.chave === "PADRAO") ||
      null
    );
  }

  // ---------------- Blocos de dados ----------------
  async function fichaProduto(ctx, id) {
    const r = await consultar(ctx, `/products/${id}`, {}, TTL_LONGO);
    if (!r.ok) return { erro: r };
    const d = r.dados || {};
    const atributos = (Array.isArray(d.attributes) ? d.attributes : [])
      .map(a => ({ id: a.id, nome: a.name ?? a.id, valor: valorAtributo(a) }))
      .filter(a => a.valor && a.valor.length <= 120);
    const v = d.buy_box_winner || null;
    return {
      id: d.id ?? id,
      titulo: d.name ?? null,
      dominio: d.domain_id ?? null,
      status: d.status ?? null,
      parentId: d.parent_id ?? null,
      imagens: (Array.isArray(d.pictures) ? d.pictures : [])
        .map(p => p.url || p.secure_url)
        .filter(Boolean)
        .slice(0, 8),
      caracteristicas: (Array.isArray(d.main_features) ? d.main_features : [])
        .map(f => f.text)
        .filter(Boolean)
        .slice(0, 8),
      descricaoCurta: d.short_description?.content ?? null,
      atributos,
      vencedorCatalogo: v
        ? {
            anuncioId: v.item_id ?? null,
            preco: v.price ?? null,
            moeda: v.currency_id ?? null,
            vendedorId: v.seller_id ?? null,
            freteGratis: v.shipping?.free_shipping ?? null,
            tipoAnuncio: v.listing_type_id ?? null
          }
        : null,
      permalink: d.permalink || null
    };
  }

  async function ofertasProduto(ctx, id) {
    const r = await consultar(ctx, `/products/${id}/items`, {}, TTL);
    if (!r.ok) return indisponivel(r);
    const lista = Array.isArray(r.dados?.results) ? r.dados.results : [];
    const ofertas = lista.map(o => ({
      anuncioId: o.item_id ?? o.id ?? null,
      preco: typeof o.price === "number" ? o.price : null,
      precoOriginal: typeof o.original_price === "number" ? o.original_price : null,
      moeda: o.currency_id ?? "BRL",
      vendedorId: o.seller_id ?? null,
      lojaOficial: o.official_store_id ?? null,
      freteGratis: o.shipping?.free_shipping ?? null,
      logistica: o.shipping?.logistic_type ?? null,
      tipoAnuncio: o.listing_type_id ?? null,
      condicao: o.condition ?? null,
      garantia: o.warranty ?? null
    }));
    const precos = ofertas.map(o => o.preco).filter(p => typeof p === "number" && p > 0);
    const vendedores = new Set(ofertas.map(o => o.vendedorId).filter(Boolean));
    const min = precos.length ? Math.min(...precos) : null;
    const max = precos.length ? Math.max(...precos) : null;
    return {
      disponivel: true,
      fonte: "API Mercado Livre /products/{id}/items",
      total: r.dados?.paging?.total ?? ofertas.length,
      ofertas: ofertas.sort((a, b) => (a.preco ?? Infinity) - (b.preco ?? Infinity)),
      resumo: {
        quantidadeOfertas: ofertas.length,
        vendedoresDistintos: vendedores.size,
        precoMinimo: min,
        precoMaximo: max,
        precoMediano: arred(mediana(precos)),
        variacaoPercentual: min && max ? arred(((max - min) / min) * 100, 1) : null,
        percentualFreteGratis: ofertas.length
          ? arred((ofertas.filter(o => o.freteGratis).length / ofertas.length) * 100, 0)
          : null,
        lojasOficiais: ofertas.filter(o => o.lojaOficial).length,
        fulfillment: ofertas.filter(o => o.logistica === "fulfillment").length
      }
    };
  }

  async function perfilVendedores(ctx, ids) {
    const unicos = [...new Set(ids.filter(Boolean))].slice(0, 8);
    const perfis = await emLotes(unicos, async id => {
      const r = await consultar(ctx, `/users/${id}`, {}, TTL_LONGO);
      if (!r.ok) return { id, disponivel: false, httpMercadoLivre: r.status };
      const d = r.dados || {};
      const rep = d.seller_reputation || {};
      return {
        id,
        disponivel: true,
        apelido: d.nickname ?? null,
        estado: d.address?.state ?? null,
        nivelReputacao: rep.level_id ?? null,
        mercadoLider: rep.power_seller_status ?? null,
        vendasConcluidas: rep.transactions?.completed ?? null,
        vendasTotais: rep.transactions?.total ?? null,
        perfil: typeof d.permalink === "string" ? d.permalink : null
      };
    });
    return Object.fromEntries(perfis.map(p => [p.id, p]));
  }

  async function tarifasVenda(ctx, preco, categoria) {
    if (!preco || !ID_CATEGORIA.test(categoria || "")) {
      return { disponivel: false, motivo: "Preço de referência ou categoria ausentes" };
    }
    const r = await consultar(
      ctx, "/sites/MLB/listing_prices",
      { price: arred(preco), category_id: categoria },
      TTL_LONGO
    );
    if (!r.ok || !Array.isArray(r.dados)) return indisponivel(r);
    const tipos = r.dados
      .filter(t => ["gold_special", "gold_pro"].includes(t.listing_type_id))
      .map(t => ({
        tipo: t.listing_type_id,
        nome: t.listing_type_name ?? t.listing_type_id,
        tarifaVenda: t.sale_fee_amount ?? null,
        percentual: t.sale_fee_details?.percentage_fee ?? null,
        taxaFixa: t.sale_fee_details?.fixed_fee ?? null
      }));
    return {
      disponivel: tipos.length > 0,
      fonte: "API Mercado Livre /sites/MLB/listing_prices",
      precoReferencia: arred(preco),
      tipos
    };
  }

  async function rankingCategoria(ctx, categoria) {
    if (!ID_CATEGORIA.test(categoria || "")) return null;
    const r = await consultar(ctx, `/highlights/MLB/category/${categoria}`, {}, TTL);
    if (!r.ok || !Array.isArray(r.dados?.content)) return null;
    return r.dados.content.map(x => ({
      id: x.id, tipo: x.type ?? null, posicao: x.position ?? null
    }));
  }

  // Indicador AnPrice: calculado, transparente e com confiabilidade.
  function indicadorOportunidade({ posicao, rankingConsultado, resumo, comissaoValor }) {
    const componentes = [];
    if (posicao) {
      componentes.push({
        nome: "Demanda", max: 35,
        pontos: arred(35 * Math.max(0.15, 1 - (posicao - 1) / 20), 0),
        explicacao: `${posicao}º entre os mais vendidos da categoria`
      });
    } else if (rankingConsultado) {
      componentes.push({ nome: "Demanda", max: 35, pontos: 4, explicacao: "Fora do top de mais vendidos da categoria" });
    } else {
      componentes.push({ nome: "Demanda", max: 35, pontos: null, explicacao: "Ranking não consultado (categoria desconhecida)" });
    }
    if (resumo?.vendedoresDistintos) {
      const n = resumo.vendedoresDistintos;
      const p = n <= 3 ? 25 : n <= 8 ? 16 : n <= 20 ? 8 : 3;
      componentes.push({ nome: "Concorrência", max: 25, pontos: p, explicacao: `${n} vendedores disputando este produto` });
    } else {
      componentes.push({ nome: "Concorrência", max: 25, pontos: null, explicacao: "Ofertas não liberadas pela API" });
    }
    if (comissaoValor !== null && comissaoValor !== undefined) {
      const p = arred(25 * Math.min(1, Math.log10(1 + comissaoValor) / Math.log10(201)), 0);
      componentes.push({ nome: "Comissão estimada", max: 25, pontos: p, explicacao: `≈ R$ ${comissaoValor.toFixed(2)} por venda (taxa informada por você)` });
    } else {
      componentes.push({ nome: "Comissão estimada", max: 25, pontos: null, explicacao: "Cadastre a taxa de comissão desta categoria" });
    }
    if (resumo?.quantidadeOfertas) {
      let p = 0;
      const partes = [];
      if (resumo.percentualFreteGratis !== null) {
        p += Math.round((resumo.percentualFreteGratis / 100) * 8);
        partes.push(`${resumo.percentualFreteGratis}% com frete grátis`);
      }
      if (resumo.lojasOficiais) { p += 3; partes.push("tem loja oficial"); }
      if (resumo.variacaoPercentual >= 15) { p += 4; partes.push(`preços variam ${resumo.variacaoPercentual}%`); }
      componentes.push({ nome: "Condições de compra", max: 15, pontos: p, explicacao: partes.join(" · ") || "Sem destaques" });
    } else {
      componentes.push({ nome: "Condições de compra", max: 15, pontos: null, explicacao: "Ofertas não liberadas pela API" });
    }
    const validos = componentes.filter(c => c.pontos !== null);
    const maxValido = validos.reduce((s, c) => s + c.max, 0);
    const soma = validos.reduce((s, c) => s + c.pontos, 0);
    const confiabilidade = Math.round((maxValido / 100) * 100);
    return {
      tipo: "INDICADOR_CALCULADO",
      nota: maxValido && confiabilidade >= 50 ? Math.round((soma / maxValido) * 100) : null,
      notaParcial: maxValido ? Math.round((soma / maxValido) * 100) : null,
      confiabilidade,
      situacao: confiabilidade >= 50 ? "calculado" : "dados_insuficientes",
      componentes,
      aviso: "Indicador calculado pelo AnPrice a partir dos dados disponíveis. Não é garantia de vendas, lucro ou comissão."
    };
  }

  async function analisarProduto(ctx, id, categoria, opcoes = {}) {
    const ficha = await fichaProduto(ctx, id);
    if (ficha.erro) return { erro: ficha.erro };

    const ofertas = await ofertasProduto(ctx, id);
    const vendedores = ofertas.disponivel && opcoes.vendedores !== false
      ? await perfilVendedores(ctx, ofertas.ofertas.map(o => o.vendedorId))
      : {};
    if (ofertas.disponivel) {
      for (const o of ofertas.ofertas) o.vendedor = vendedores[o.vendedorId] || null;
    }

    const precoReferencia =
      ofertas.resumo?.precoMinimo ??
      ficha.vencedorCatalogo?.preco ??
      null;

    const ranking = await rankingCategoria(ctx, categoria);
    const noRanking = ranking?.find(x => x.id === id || (ficha.parentId && x.id === ficha.parentId));

    const tarifas = opcoes.tarifas === false
      ? { disponivel: false, motivo: "Não solicitado" }
      : await tarifasVenda(ctx, precoReferencia, categoria);

    const taxa = await comissaoPara(ficha.dominio, categoria);
    const comissaoValor = taxa && precoReferencia
      ? arred(precoReferencia * (taxa.percentual / 100))
      : null;

    return {
      produto: ficha,
      ofertas,
      precoReferencia: precoReferencia !== null
        ? { valor: precoReferencia, origem: ofertas.resumo?.precoMinimo != null ? "menor oferta ativa" : "vencedor do catálogo" }
        : null,
      ranking: {
        categoria: ID_CATEGORIA.test(categoria || "") ? categoria : null,
        consultado: Boolean(ranking),
        posicao: noRanking?.posicao ?? null
      },
      tarifas,
      afiliado: {
        taxa: taxa
          ? { percentual: taxa.percentual, chave: taxa.chave, rotulo: taxa.rotulo ?? null, fonte: "INFORMADA_PELO_USUARIO" }
          : null,
        comissaoEstimada: comissaoValor,
        elegibilidade: "nao_verificada",
        observacao: "A API pública não informa comissão nem elegibilidade de afiliados. O valor é uma estimativa com a taxa que você cadastrou."
      },
      indicador: indicadorOportunidade({
        posicao: noRanking?.posicao ?? null,
        rankingConsultado: Boolean(ranking),
        resumo: ofertas.resumo,
        comissaoValor
      }),
      links: {
        pesquisaPublica: ficha.titulo
          ? `https://lista.mercadolivre.com.br/${encodeURIComponent(
              ficha.titulo.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
                .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80)
            )}`
          : null,
        paginaProduto: ficha.permalink
      }
    };
  }

  function consumo(ctx) {
    return { chamadasApi: ctx.chamadas, respostasDoCache: ctx.cache, resultadoParcial: ctx.bloqueado429, retryAfter: ctx.retryAfter };
  }

  // ===================== ROTAS =====================

  app.get("/api/ml/v2/produto", exigirAdmin, rotaSegura(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const id = String(req.query.id || "");
    const categoria = String(req.query.categoria || "");
    if (!ID_PRODUTO.test(id)) {
      return res.status(400).json({ sucesso: false, erro: "ID de produto inválido" });
    }
    const ctx = contexto();
    const a = await analisarProduto(ctx, id, categoria);
    if (a.erro) return erroML(res, a.erro, "produto");
    return res.json({ sucesso: true, ...a, consumo: consumo(ctx), consultadoEm: new Date().toISOString() });
  }));

  app.get("/api/ml/v2/comparar", exigirAdmin, rotaSegura(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const ids = [...new Set(String(req.query.ids || "").split(",").map(s => s.trim()).filter(Boolean))];
    const categoria = String(req.query.categoria || "");
    if (ids.length < 2 || ids.length > 4 || !ids.every(i => ID_PRODUTO.test(i))) {
      return res.status(400).json({ sucesso: false, erro: "Informe de 2 a 4 IDs de produto" });
    }
    const ctx = contexto();
    const analises = [];
    for (const id of ids) {
      const a = await analisarProduto(ctx, id, categoria, { vendedores: false });
      analises.push(a.erro ? { id, erro: indisponivel(a.erro) } : a);
    }

    // Tabela de atributos alinhada.
    const validos = analises.filter(a => !a.erro);
    const ordem = [];
    const nomes = {};
    for (const a of validos) {
      for (const at of a.produto.atributos) {
        if (!nomes[at.id]) { nomes[at.id] = at.nome; ordem.push(at.id); }
      }
    }
    const atributos = ordem
      .map(idAttr => {
        const valores = validos.map(a => a.produto.atributos.find(x => x.id === idAttr)?.valor ?? null);
        const preenchidos = valores.filter(Boolean);
        return {
          id: idAttr, nome: nomes[idAttr], valores,
          diferente: new Set(preenchidos).size > 1,
          cobertura: preenchidos.length
        };
      })
      .filter(l => l.cobertura >= Math.min(2, validos.length))
      .sort((a, b) => b.diferente - a.diferente || b.cobertura - a.cobertura)
      .slice(0, 40);

    return res.json({
      sucesso: true,
      produtos: analises.map(a => a.erro ? a : {
        id: a.produto.id,
        titulo: a.produto.titulo,
        imagem: a.produto.imagens[0] ?? null,
        dominio: a.produto.dominio,
        precoReferencia: a.precoReferencia,
        ofertas: a.ofertas.disponivel ? a.ofertas.resumo : null,
        motivoOfertas: a.ofertas.disponivel ? null : a.ofertas.motivo,
        posicaoRanking: a.ranking.posicao,
        tarifas: a.tarifas,
        afiliado: a.afiliado,
        indicador: a.indicador,
        links: a.links
      }),
      atributos,
      consumo: consumo(ctx)
    });
  }));

  app.get("/api/ml/v2/radar", exigirAdmin, rotaSegura(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const categoria = String(req.query.categoria || "");
    if (!ID_CATEGORIA.test(categoria)) {
      return res.status(400).json({ sucesso: false, erro: "Categoria inválida (ex.: MLB1055)" });
    }
    const ctx = contexto();
    const [cat, ranking, tendencias] = await Promise.all([
      consultar(ctx, `/categories/${categoria}`, {}, TTL_LONGO),
      rankingCategoria(ctx, categoria),
      consultar(ctx, `/trends/MLB/${categoria}`, {}, TTL)
    ]);

    let itens = [];
    if (ranking) {
      const produtos = ranking
        .sort((a, b) => (a.posicao ?? 999) - (b.posicao ?? 999))
        .slice(0, 20);
      itens = await emLotes(produtos, async x => {
        if (x.tipo !== "PRODUCT" || !ID_PRODUTO.test(x.id)) {
          return { ...x, detalhesDisponiveis: false, observacao: "Anúncio de terceiro: detalhes não liberados pela API" };
        }
        const f = await fichaProduto(ctx, x.id);
        if (f.erro) return { ...x, detalhesDisponiveis: false, httpMercadoLivre: f.erro.status };
        return {
          ...x,
          detalhesDisponiveis: true,
          titulo: f.titulo,
          imagem: f.imagens[0] ?? null,
          dominio: f.dominio,
          precoVencedor: f.vencedorCatalogo?.preco ?? null
        };
      });
    }

    return res.json({
      sucesso: true,
      categoria: {
        id: categoria,
        nome: cat.ok ? cat.dados?.name ?? null : null,
        caminho: cat.ok && Array.isArray(cat.dados?.path_from_root)
          ? cat.dados.path_from_root.map(p => ({ id: p.id, nome: p.name }))
          : [],
        subcategorias: cat.ok && Array.isArray(cat.dados?.children_categories)
          ? cat.dados.children_categories.slice(0, 30).map(c => ({ id: c.id, nome: c.name, total: c.total_items_in_this_category ?? null }))
          : []
      },
      maisVendidos: ranking ? { disponivel: true, itens } : { disponivel: false, motivo: "Ranking indisponível para esta categoria" },
      tendencias: tendencias.ok && Array.isArray(tendencias.dados)
        ? { disponivel: true, fonte: "API Mercado Livre /trends", termos: tendencias.dados.slice(0, 30).map(t => ({ termo: t.keyword, url: t.url ?? null })) }
        : indisponivel(tendencias),
      consumo: consumo(ctx)
    });
  }));

  app.get("/api/ml/v2/concorrencia", exigirAdmin, rotaSegura(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const ctx = contexto();
    const me = await consultar(ctx, "/users/me", {}, TTL);
    if (!me.ok) return erroML(res, me, "usuario");
    const userId = me.dados.id;

    let busca = await consultar(ctx, `/users/${userId}/items/search`, { catalog_listing: "true", status: "active", limit: 20 }, 2 * 60 * 1000);
    let somenteCatalogo = true;
    if (!busca.ok || !busca.dados?.results?.length) {
      busca = await consultar(ctx, `/users/${userId}/items/search`, { status: "active", limit: 20 }, 2 * 60 * 1000);
      somenteCatalogo = false;
    }
    if (!busca.ok) return erroML(res, busca, "meus_anuncios");
    const ids = (busca.dados.results || []).filter(i => /^MLB\d+$/.test(i)).slice(0, 20);

    let itens = [];
    if (ids.length) {
      const multi = await consultar(ctx, "/items", { ids: ids.join(","), attributes: "id,title,price,thumbnail,permalink,catalog_product_id,catalog_listing,available_quantity,sold_quantity,listing_type_id,category_id,status" }, 2 * 60 * 1000);
      const corpos = multi.ok && Array.isArray(multi.dados)
        ? multi.dados.filter(x => x.code === 200).map(x => x.body)
        : [];
      itens = await emLotes(corpos, async it => {
        const base = {
          anuncioId: it.id,
          titulo: it.title ?? null,
          preco: it.price ?? null,
          imagem: it.thumbnail ?? null,
          link: it.permalink ?? null,
          produtoCatalogo: it.catalog_product_id ?? null,
          anuncioCatalogo: it.catalog_listing ?? null,
          estoque: it.available_quantity ?? null,
          vendidos: it.sold_quantity ?? null,
          categoria: it.category_id ?? null,
          tipoAnuncio: it.listing_type_id ?? null
        };
        if (!it.catalog_listing) {
          return { ...base, competicao: { disponivel: false, motivo: "Anúncio fora do catálogo: sem disputa de vencedor" } };
        }
        const p = await consultar(ctx, `/items/${it.id}/price_to_win`, { siteId: "MLB", version: "v2" }, 2 * 60 * 1000);
        if (!p.ok) return { ...base, competicao: indisponivel(p) };
        const d = p.dados || {};
        const status = d.status ?? null;
        const diferenca = typeof d.price_to_win === "number" && typeof d.current_price === "number"
          ? arred(d.current_price - d.price_to_win) : null;
        return {
          ...base,
          competicao: {
            disponivel: true,
            status,
            precoAtual: d.current_price ?? null,
            precoParaGanhar: d.price_to_win ?? null,
            diferenca,
            vencedor: d.winner
              ? { anuncioId: d.winner.item_id ?? null, preco: d.winner.price ?? null, vantagens: (d.winner.boosts || []).filter(b => b.status === "boosted").map(b => b.description || b.id) }
              : null,
            oportunidades: (d.boosts || []).filter(b => b.status === "opportunity").map(b => b.description || b.id),
            vantagensAtivas: (d.boosts || []).filter(b => b.status === "boosted").map(b => b.description || b.id),
            motivos: Array.isArray(d.reason) ? d.reason : d.reason ? [d.reason] : []
          }
        };
      });
    }

    const resumo = { total: itens.length, ganhando: 0, perdendo: 0, compartilhando: 0, outros: 0 };
    for (const i of itens) {
      const s = i.competicao?.status;
      if (s === "winning") resumo.ganhando++;
      else if (s === "competing") resumo.perdendo++;
      else if (s === "sharing_first_place") resumo.compartilhando++;
      else resumo.outros++;
    }

    return res.json({
      sucesso: true,
      conta: { id: userId, apelido: me.dados.nickname ?? null },
      somenteCatalogo,
      resumo,
      itens,
      consumo: consumo(ctx)
    });
  }));

  app.get("/api/ml/v2/comissoes", exigirAdmin, rotaSegura(async (_req, res) => {
    const lista = await listarComissoes();
    if (!lista) return res.status(503).json({ sucesso: false, erro: "Banco de dados indisponível" });
    res.json({ sucesso: true, fonte: "INFORMADA_PELO_USUARIO", comissoes: lista });
  }));

  app.post("/api/ml/v2/comissoes", exigirAdmin, rotaSegura(async (req, res) => {
    const b = req.body || {};
    const chaveTaxa = String(b.chave || "").trim();
    const rotulo = typeof b.rotulo === "string" ? b.rotulo.trim().slice(0, 80) : null;
    if (!(chaveTaxa === "PADRAO" || ID_DOMINIO.test(chaveTaxa) || ID_CATEGORIA.test(chaveTaxa))) {
      return res.status(400).json({ sucesso: false, erro: "Use PADRAO, um domínio (MLB-...) ou uma categoria (MLB123)" });
    }
    const col = await colecaoComissoes();
    if (b.percentual === null || b.remover === true) {
      await col.deleteOne({ chave: chaveTaxa });
      return res.json({ sucesso: true, removido: chaveTaxa });
    }
    const percentual = Number(b.percentual);
    if (!Number.isFinite(percentual) || percentual < 0 || percentual > 50) {
      return res.status(400).json({ sucesso: false, erro: "Percentual deve estar entre 0 e 50" });
    }
    await col.updateOne(
      { chave: chaveTaxa },
      { $set: { chave: chaveTaxa, percentual: arred(percentual, 2), rotulo, fonte: "INFORMADA_PELO_USUARIO", atualizadoEm: new Date().toISOString() } },
      { upsert: true }
    );
    res.json({ sucesso: true });
  }));

  app.get("/api/ml/v2/recursos", exigirAdmin, rotaSegura(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const ctx = contexto();
    const exemplo = ID_PRODUTO.test(String(req.query.produto || "")) ? req.query.produto : "MLB47306351";
    const testes = [
      ["Catálogo (busca)", "/products/search", { site_id: "MLB", status: "active", q: "celular", limit: 1 }],
      ["Ficha do produto", `/products/${exemplo}`, {}],
      ["Ofertas do produto", `/products/${exemplo}/items`, {}],
      ["Mais vendidos", "/highlights/MLB/category/MLB1055", {}],
      ["Tendências", "/trends/MLB/MLB1055", {}],
      ["Tarifas de venda", "/sites/MLB/listing_prices", { price: 100, category_id: "MLB1055" }],
      ["Conta conectada", "/users/me", {}],
      ["Busca pública de anúncios", "/sites/MLB/search", { q: "celular", limit: 1 }]
    ];
    const resultado = [];
    for (const [nome, caminho, params] of testes) {
      const r = await consultar(ctx, caminho, params, 5 * 60 * 1000);
      resultado.push({ recurso: nome, caminho, disponivel: r.ok, httpMercadoLivre: r.status || null });
    }
    res.json({ sucesso: true, recursos: resultado, consumo: consumo(ctx) });
  }));
}

module.exports = { registrarInteligenciaMercado, _interno: { mediana, cache } };
