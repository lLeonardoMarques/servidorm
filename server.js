
"use strict";

const express = require("express");
const crypto = require("node:crypto");
const { conectarMongoDB, verificarMongoDB } = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI = process.env.ML_REDIRECT_URI;
const OAUTH_KEY = process.env.ML_OAUTH_KEY;
const TOKEN_KEY = process.env.ML_TOKEN_KEY;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const COOKIE = "ml_oauth";
const TOKEN_ID = "primary";
const API = "https://api.mercadolibre.com";

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// ======================================
// CONFIGURACAO E SEGURANCA
// ======================================

function chaveValida(s) {
  return typeof s === "string" && /^[a-f\d]{64}$/i.test(s);
}

function configurado() {
  return Boolean(
    CLIENT_ID &&
    CLIENT_SECRET &&
    REDIRECT_URI &&
    chaveValida(OAUTH_KEY) &&
    chaveValida(TOKEN_KEY) &&
    ADMIN_USER &&
    ADMIN_PASSWORD
  );
}

function compararSeguro(a, b) {
  const x = crypto.createHash("sha256")
    .update(String(a)).digest();
  const y = crypto.createHash("sha256")
    .update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function exigirAdmin(req, res, next) {
  res.set("Cache-Control", "no-store");

  if (!ADMIN_USER || !ADMIN_PASSWORD) {
    return res.status(503).json({
      erro: "Administrador nao configurado"
    });
  }

  const header = req.headers.authorization || "";

  if (header.startsWith("Basic ")) {
    try {
      const texto = Buffer.from(
        header.slice(6), "base64"
      ).toString("utf8");

      const pos = texto.indexOf(":");

      if (
        pos >= 0 &&
        compararSeguro(texto.slice(0, pos), ADMIN_USER) &&
        compararSeguro(texto.slice(pos + 1), ADMIN_PASSWORD)
      ) {
        return next();
      }
    } catch {
      // Credenciais invalidas
    }
  }

  res.set(
    "WWW-Authenticate",
    'Basic realm="Servidor M"'
  );

  return res.status(401).json({
    erro: "Acesso administrativo nao autorizado"
  });
}

// ======================================
// CRIPTOGRAFIA AES-256-GCM
// ======================================

function criptografar(dados, chaveHex) {
  const iv = crypto.randomBytes(12);

  const cifra = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(chaveHex, "hex"),
    iv
  );

  const corpo = Buffer.concat([
    cifra.update(JSON.stringify(dados), "utf8"),
    cifra.final()
  ]);

  return Buffer.concat([
    iv,
    cifra.getAuthTag(),
    corpo
  ]).toString("base64url");
}

function descriptografar(valor, chaveHex) {
  const b = Buffer.from(valor, "base64url");

  if (b.length < 29) {
    throw new Error("Dados criptografados invalidos");
  }

  const decifra = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(chaveHex, "hex"),
    b.subarray(0, 12)
  );

  decifra.setAuthTag(b.subarray(12, 28));

  return JSON.parse(
    Buffer.concat([
      decifra.update(b.subarray(28)),
      decifra.final()
    ]).toString("utf8")
  );
}

// ======================================
// COOKIES OAUTH
// ======================================

function lerCookie(req, nome) {
  for (const parte of (req.headers.cookie || "").split(";")) {
    const [chave, ...valor] = parte.trim().split("=");

    if (chave === nome) {
      return valor.join("=");
    }
  }

  return null;
}

function limparCookie(res) {
  res.clearCookie(COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/ml"
  });
}

// ======================================
// MONGODB - TOKENS CRIPTOGRAFADOS
// ======================================

async function colecaoTokens() {
  return (await conectarMongoDB()).collection("ml_tokens");
}

function prepararTokens(dados) {
  const duracao = Number(dados.expires_in);

  if (
    !dados.access_token ||
    !dados.refresh_token ||
    !Number.isFinite(duracao) ||
    duracao <= 0
  ) {
    throw new Error("Tokens invalidos ou incompletos");
  }

  return {
    access_token: dados.access_token,
    refresh_token: dados.refresh_token,
    user_id: dados.user_id,
    expires_at: Date.now() + duracao * 1000
  };
}

async function salvarTokens(tokens) {
  const colecao = await colecaoTokens();

  await colecao.updateOne(
    { _id: TOKEN_ID },
    {
      $set: {
        conteudo: criptografar(tokens, TOKEN_KEY),
        usuarioId: tokens.user_id,
        atualizadoEm: new Date()
      }
    },
    { upsert: true }
  );
}

async function carregarTokens() {
  const doc = await (
    await colecaoTokens()
  ).findOne({ _id: TOKEN_ID });

  return doc
    ? descriptografar(doc.conteudo, TOKEN_KEY)
    : null;
}

// ======================================
// MERCADO LIVRE - OAUTH
// ======================================

async function solicitarToken(parametros) {
  const resposta = await fetch(
    `${API}/oauth/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams(parametros),
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!resposta.ok) {
    const e = new Error("Falha no OAuth Mercado Livre");
    e.statusMercadoLivre = resposta.status;
    throw e;
  }

  return resposta.json();
}

let renovacaoPendente = null;

async function renovarTokens() {
  const atuais = await carregarTokens();

  if (!atuais?.refresh_token) {
    throw new Error("Conta nao conectada");
  }

  const dados = await solicitarToken({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: atuais.refresh_token
  });

  const novos = prepararTokens(dados);

  await salvarTokens(novos);

  return novos;
}

async function obterAccessToken(forcar = false) {
  if (!configurado()) {
    throw new Error("Configuracao incompleta");
  }

  const tokens = await carregarTokens();

  if (!tokens) {
    throw new Error("Conta nao conectada");
  }

  if (
    !forcar &&
    tokens.expires_at > Date.now() + 120000
  ) {
    return tokens.access_token;
  }

  if (!renovacaoPendente) {
    renovacaoPendente = renovarTokens().finally(() => {
      renovacaoPendente = null;
    });
  }

  return (await renovacaoPendente).access_token;
}

// ======================================
// CLIENTE PADRONIZADO DA API
// ======================================

async function mlGet(
  caminho,
  parametros = {},
  repetir401 = true
) {
  const url = new URL(caminho, API);

  for (const [chave, valor] of Object.entries(parametros)) {
    if (
      valor !== undefined &&
      valor !== null &&
      valor !== ""
    ) {
      url.searchParams.set(chave, String(valor));
    }
  }

  const token = await obterAccessToken();

  async function buscar(t) {
    const resposta = await fetch(url, {
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });

    const texto = await resposta.text();

    let dados;

    try {
      dados = JSON.parse(texto);
    } catch {
      dados = {
        message: texto.slice(0, 300)
      };
    }

    return {
      ok: resposta.ok,
      status: resposta.status,
      dados,
      retryAfter: resposta.headers.get("retry-after")
    };
  }

  let resultado = await buscar(token);

  if (resultado.status === 401 && repetir401) {
    resultado = await buscar(
      await obterAccessToken(true)
    );
  }

  return resultado;
}

async function mlGetComToken(caminho, token) {
  const resposta = await fetch(
    `${API}${caminho}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  return {
    ok: resposta.ok,
    status: resposta.status,
    dados: await resposta.json()
  };
}

// ======================================
// TRATAMENTO DE ERROS
// ======================================

function erroML(res, resultado, etapa) {
  return res.status(resultado.status).json({
    sucesso: false,
    etapa,
    httpMercadoLivre: resultado.status,
    erro:
      resultado.dados?.message ??
      resultado.dados?.error ??
      "Requisicao recusada",
    retryAfter: resultado.retryAfter
  });
}

function erroInterno(res, e, etapa) {
  console.error(etapa, {
    nome: e.name,
    mensagem: e.message,
    httpMercadoLivre: e.statusMercadoLivre || null
  });

  return res.status(502).json({
    sucesso: false,
    etapa,
    erro: "Falha de comunicacao ou autenticacao",
    httpMercadoLivre: e.statusMercadoLivre || null
  });
}

function categoriaValida(id) {
  return /^MLB\d+$/.test(id);
}

function itemValido(id) {
  return /^MLB\d+$/.test(id);
}

function limiteValido(valor, max = 20) {
  const n = Number(valor);

  return Number.isInteger(n) && n >= 1 && n <= max
    ? n
    : null;
}

function rotaSegura(funcao) {
  return async (req, res) => {
    try {
      await funcao(req, res);
    } catch (e) {
      erroInterno(res, e, req.path);
    }
  };
}

// ======================================
// NORMALIZACAO DE PRODUTOS
// ======================================

function resumoItem(d) {
  return {
    id: d.id ?? null,
    titulo: d.title ?? null,
    preco: d.price ?? null,
    moeda: d.currency_id ?? null,
    imagem:
      d.thumbnail ??
      d.pictures?.[0]?.secure_url ??
      null,
    link: d.permalink ?? null,
    vendedorId: d.seller_id ?? null,
    status: d.status ?? null,
    categoria: d.category_id ?? null,
    quantidadeDisponivel:
      d.available_quantity ?? null
  };
}

function resumoProduto(d) {
  const v = d.buy_box_winner;

  return {
    id: d.id ?? null,
    titulo: d.name ?? null,
    imagem:
      d.pictures?.[0]?.url ??
      d.pictures?.[0]?.secure_url ??
      null,
    link: d.permalink ?? null,
    status: d.status ?? null,
    dominio: d.domain_id ?? null,
    preco: v?.price ?? null,
    moeda: v?.currency_id ?? null,
    vendedorId: v?.seller_id ?? null,
    anuncioVencedorId: v?.item_id ?? null,
    reputacaoVencedor:
      v?.seller?.reputation_level_id ?? null,
    freteGratisVencedor:
      v?.shipping?.free_shipping ?? null,
    faixaPrecos:
      d.buy_box_winner_price_range ?? null
  };
}

// ======================================
// STATUS DO SERVIDOR
// ======================================

app.get("/", (_req, res) => {
  res.json({
    projeto: "Servidor M",
    sistema: "AnPrice",
    versao: "2.0.0",
    status: "online"
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    servidor: "online",
    versao: "2.0.0",
    timestamp: new Date().toISOString()
  });
});

// ======================================
// STATUS MONGODB
// ======================================

app.get(
  "/api/db/status",
  exigirAdmin,
  rotaSegura(async (_req, res) => {
    try {
      await verificarMongoDB();

      res.json({
        sucesso: true,
        banco: "MongoDB Atlas",
        conexao: "online"
      });
    } catch {
      res.status(503).json({
        sucesso: false,
        conexao: "indisponivel"
      });
    }
  })
);

// ======================================
// STATUS DA CONEXAO MERCADO LIVRE
// ======================================

app.get(
  "/api/ml/status",
  exigirAdmin,
  rotaSegura(async (_req, res) => {
    if (!configurado()) {
      return res.status(503).json({
        configurado: false
      });
    }

    const t = await carregarTokens();

    res.json({
      configurado: true,
      conectado: Boolean(t),
      usuarioId: t?.user_id ?? null,
      tokenValidoAte: t
        ? new Date(t.expires_at).toISOString()
        : null,
      armazenamento: "MongoDB Atlas criptografado"
    });
  })
);

// ======================================
// INICIAR AUTORIZACAO OAUTH PKCE
// ======================================

app.get("/api/ml/auth", exigirAdmin, (req, res) => {
  if (!configurado()) {
    return res.status(503).json({
      erro: "Configuracao incompleta"
    });
  }

  const verifier = crypto
    .randomBytes(32)
    .toString("base64url");

  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  const state = crypto
    .randomBytes(24)
    .toString("hex");

  res.cookie(
    COOKIE,
    criptografar({
      verifier,
      state,
      criadoEm: Date.now()
    }, OAUTH_KEY),
    {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/ml",
      maxAge: 600000
    }
  );

  const url = new URL(
    "https://auth.mercadolivre.com.br/authorization"
  );

  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state
  })) {
    url.searchParams.set(k, v);
  }

  res.redirect(url.toString());
});

// ======================================
// CALLBACK OAUTH
// ======================================

app.get("/api/ml/callback", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const cookie = lerCookie(req, COOKIE);
  limparCookie(res);

  if (!configurado() || !cookie) {
    return res.status(400).json({
      erro: "Sessao OAuth ausente"
    });
  }

  let sessao;

  try {
    sessao = descriptografar(cookie, OAUTH_KEY);

    const agora = Date.now();

    if (
      typeof sessao.criadoEm !== "number" ||
      agora - sessao.criadoEm > 600000 ||
      sessao.criadoEm > agora ||
      typeof req.query.state !== "string" ||
      !compararSeguro(req.query.state, sessao.state)
    ) {
      throw new Error("Estado invalido");
    }
  } catch {
    return res.status(400).json({
      erro: "Sessao OAuth invalida ou expirada"
    });
  }

  if (req.query.error) {
    return res.status(400).json({
      erro: "Autorizacao recusada"
    });
  }

  if (typeof req.query.code !== "string") {
    return res.status(400).json({
      erro: "Codigo OAuth ausente"
    });
  }

  try {
    const resposta = await solicitarToken({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: req.query.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: sessao.verifier
    });

    const tokens = prepararTokens(resposta);

    const usuario = await mlGetComToken(
      "/users/me",
      tokens.access_token
    );

    if (
      !usuario.ok ||
      String(usuario.dados.id) !== String(tokens.user_id)
    ) {
      throw new Error("Identidade divergente");
    }

    await salvarTokens(tokens);

    return res.json({
      sucesso: true,
      mensagem: "Mercado Livre conectado",
      usuario: {
        id: usuario.dados.id,
        nickname: usuario.dados.nickname
      }
    });
  } catch (e) {
    return erroInterno(res, e, "callback_oauth");
  }
});

// ======================================
// CONSULTAR CONTA CONECTADA
// ======================================

app.get(
  "/api/ml/me",
  exigirAdmin,
  rotaSegura(async (_req, res) => {
    const r = await mlGet("/users/me");

    if (!r.ok) {
      return erroML(res, r, "consultar_conta");
    }

    const u = r.dados;

    res.json({
      sucesso: true,
      usuario: {
        id: u.id,
        nickname: u.nickname,
        site_id: u.site_id,
        seller_reputation:
          u.seller_reputation ?? null
      }
    });
  })
);

// ======================================
// CATEGORIAS E SUBCATEGORIAS
// ======================================

app.get(
  "/api/ml/categorias",
  exigirAdmin,
  rotaSegura(async (req, res) => {
    const pai =
      typeof req.query.pai === "string"
        ? req.query.pai.trim().toUpperCase()
        : "";

    if (pai && !categoriaValida(pai)) {
      return res.status(400).json({
        sucesso: false,
        erro: "Categoria pai invalida"
      });
    }

    const r = await mlGet(
      pai
        ? `/categories/${pai}`
        : "/sites/MLB/categories"
    );

    if (!r.ok) {
      return erroML(res, r, "categorias");
    }

    const lista = pai
      ? r.dados.children_categories
      : r.dados;

    if (!Array.isArray(lista)) {
      return res.status(502).json({
        sucesso: false,
        erro: "Formato de categorias inesperado"
      });
    }

    res.json({
      sucesso: true,
      categoriaPai: pai || null,
      nomeCategoriaPai:
        pai ? r.dados.name ?? null : null,
      categoriaFinal: Boolean(
        pai && lista.length === 0
      ),
      total: lista.length,
      categorias: lista.map(x => ({
        id: x.id,
        nome: x.name
      }))
    });
  })
);

// ======================================
// SUGERIR CATEGORIA PELO NOME
// ======================================

app.get(
  "/api/ml/sugerir-categoria",
  exigirAdmin,
  rotaSegura(async (req, res) => {
    const q =
      typeof req.query.q === "string"
        ? req.query.q.trim()
        : "";

    if (q.length < 2 || q.length > 100) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe q entre 2 e 100 caracteres"
      });
    }

    const r = await mlGet(
      "/sites/MLB/domain_discovery/search",
      { q, limit: 3 }
    );

    if (!r.ok) {
      return erroML(res, r, "sugerir_categoria");
    }

    res.json({
      sucesso: true,
      pesquisa: q,
      sugestoes: Array.isArray(r.dados)
        ? r.dados.map(x => ({
            dominioId: x.domain_id ?? null,
            dominio: x.domain_name ?? null,
            categoriaId: x.category_id ?? null,
            categoria: x.category_name ?? null,
            atributos: x.attributes ?? []
          }))
        : []
    });
  })
);

// ======================================
// TOP 5, TOP 10 OU TOP 20 POR NICHO
// ======================================

app.get(
  "/api/ml/mais-vendidos",
  exigirAdmin,
  rotaSegura(async (req, res) => {
    const categoria =
      typeof req.query.categoria === "string"
        ? req.query.categoria.trim().toUpperCase()
        : "";

    const limite = limiteValido(
      req.query.limite ?? "20"
    );

    const detalhes =
      req.query.detalhes === "1" ||
      req.query.detalhes === "true";

    const atributo =
      typeof req.query.atributo === "string"
        ? req.query.atributo.trim().toUpperCase()
        : "";

    const valorAtributo =
      typeof req.query.valorAtributo === "string"
        ? req.query.valorAtributo.trim()
        : "";

    if (!categoriaValida(categoria)) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe categoria=MLB... valida"
      });
    }

    if (!limite) {
      return res.status(400).json({
        sucesso: false,
        erro: "limite deve ser inteiro entre 1 e 20"
      });
    }

    if (
      (atributo && !valorAtributo) ||
      (!atributo && valorAtributo) ||
      (
        atributo &&
        (
          !/^[A-Z][A-Z0-9_]{0,49}$/.test(atributo) ||
          !/^[\w-]{1,60}$/.test(valorAtributo)
        )
      )
    ) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe atributo e valorAtributo validos juntos"
      });
    }

    const filtros = atributo
      ? {
          attribute: atributo,
          attributeValue: valorAtributo
        }
      : {};

    const r = await mlGet(
      `/highlights/MLB/category/${categoria}`,
      filtros
    );

    if (!r.ok) {
      return erroML(res, r, "ranking");
    }

    if (!Array.isArray(r.dados.content)) {
      return res.status(502).json({
        sucesso: false,
        erro: "Formato de ranking inesperado"
      });
    }

    let ranking = r.dados.content
      .slice()
      .sort(
        (a, b) =>
          (a.position ?? 999) -
          (b.position ?? 999)
      )
      .slice(0, limite)
      .map(x => ({
        posicao: x.position ?? null,
        id: x.id ?? null,
        tipo: x.type ?? null
      }));

    // ==================================
    // DETALHAMENTO AUTOMATICO DO RANKING
    // ==================================

    if (detalhes) {
      const detalhados = [];

      for (
        let inicio = 0;
        inicio < ranking.length;
        inicio += 3
      ) {
        const lote = ranking.slice(
          inicio,
          inicio + 3
        );

        const resolvidos = await Promise.all(
          lote.map(async x => {
            if (x.tipo === "USER_PRODUCT") {
              return {
                ...x,
                detalhesDisponiveis: false,
                observacao:
                  "User Product: consulta de detalhe nao habilitada nesta versao"
              };
            }

            if (
              (x.tipo !== "PRODUCT" && x.tipo !== "ITEM") ||
              !itemValido(x.id || "")
            ) {
              return {
                ...x,
                detalhesDisponiveis: false,
                observacao: "Tipo ou ID nao suportado"
              };
            }

            try {
              const endpoint =
                x.tipo === "PRODUCT"
                  ? `/products/${x.id}`
                  : `/items/${x.id}`;

              const d = await mlGet(endpoint);

              if (!d.ok) {
                return {
                  ...x,
                  detalhesDisponiveis: false,
                  erroDetalhe: {
                    httpMercadoLivre: d.status,
                    mensagem:
                      d.dados?.message ??
                      d.dados?.error ??
                      null
                  }
                };
              }

              return {
                ...x,
                detalhesDisponiveis: true,
                ...(
                  x.tipo === "PRODUCT"
                    ? resumoProduto(d.dados)
                    : resumoItem(d.dados)
                )
              };
            } catch (e) {
              return {
                ...x,
                detalhesDisponiveis: false,
                erroDetalhe: {
                  mensagem: e.name
                }
              };
            }
          })
        );

        detalhados.push(...resolvidos);

        if (
          resolvidos.some(
            x => x.erroDetalhe?.httpMercadoLivre === 429
          )
        ) {
          detalhados.push(
            ...ranking.slice(inicio + 3).map(x => ({
              ...x,
              detalhesDisponiveis: false,
              observacao:
                "Enriquecimento interrompido por limite de requisicoes"
            }))
          );

          break;
        }
      }

      ranking = detalhados;
    }

    return res.json({
      sucesso: true,
      sistema: "AnPrice",
      recurso: "Mais vendidos por nicho",
      site: "MLB",
      categoria,
      limiteSolicitado: limite,
      totalRetornado: ranking.length,
      detalhesSolicitados: detalhes,
      filtro: atributo
        ? { atributo, valorAtributo }
        : null,
      criterios: r.dados.query_data ?? null,
      consultadoEm: new Date().toISOString(),
      aviso:
        "Ranking oficial: nao representa volume exato de vendas nem lista todos os vendedores",
      ranking
    });
  })
);

// ======================================
// CONSULTAR POSICAO NO RANKING
// ======================================

app.get(
  "/api/ml/posicao-ranking",
  exigirAdmin,
  rotaSegura(async (req, res) => {
    const tipo =
      typeof req.query.tipo === "string"
        ? req.query.tipo.trim().toUpperCase()
        : "";

    const id =
      typeof req.query.id === "string"
        ? req.query.id.trim().toUpperCase()
        : "";

    if (
      !["PRODUCT", "ITEM"].includes(tipo) ||
      !itemValido(id)
    ) {
      return res.status(400).json({
        sucesso: false,
        erro:
          "Informe tipo=PRODUCT ou ITEM e id=MLB..."
      });
    }

    const r = await mlGet(
      `/highlights/MLB/${
        tipo === "PRODUCT" ? "product" : "item"
      }/${id}`
    );

    if (!r.ok) {
      return erroML(res, r, "posicao_ranking");
    }

    res.json({
      sucesso: true,
      tipo,
      id,
      posicao: r.dados.position ?? null,
      dimensao: r.dados.dimension ?? null,
      categoriaOuFiltro: r.dados.id ?? null,
      descricao: r.dados.label ?? null
    });
  })
);

// ======================================
// DETALHES DE PRODUTO DO CATALOGO
// ======================================

app.get(
  "/api/ml/catalogo/produto",
  exigirAdmin,
  rotaSegura(async (req, res) => {
    const id =
      typeof req.query.id === "string"
        ? req.query.id.trim().toUpperCase()
        : "";

    if (!itemValido(id)) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe id=MLB..."
      });
    }

    const r = await mlGet(`/products/${id}`);

    if (!r.ok) {
      return erroML(res, r, "produto_catalogo");
    }

    res.json({
      sucesso: true,
      produto: resumoProduto(r.dados)
    });
  })
);

// ======================================
// PESQUISA TESTE: CATALOGO E ANUNCIOS
// ======================================

app.get(
  "/api/ml/pesquisa-teste",
  exigirAdmin,
  rotaSegura(async (req, res) => {
    const q =
      typeof req.query.q === "string"
        ? req.query.q.trim()
        : "";

    if (!q || q.length > 100) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe q com ate 100 caracteres"
      });
    }

    const consultas = [
      [
        "catalogo",
        "/products/search",
        {
          site_id: "MLB",
          status: "active",
          q,
          limit: 10
        }
      ],
      [
        "anuncios",
        "/sites/MLB/search",
        { q, limit: 10 }
      ]
    ];

    const resultados = {};

    for (const [nome, caminho, params] of consultas) {
      try {
        const r = await mlGet(caminho, params);

        resultados[nome] = {
          httpStatus: r.status,
          total: r.dados?.paging?.total ?? null,
          produtos:
            r.ok && Array.isArray(r.dados.results)
              ? r.dados.results.slice(0, 10).map(x => ({
                  id: x.id ?? null,
                  nome:
                    x.name ?? x.title ?? null,
                  preco: x.price ?? null,
                  moeda: x.currency_id ?? null,
                  vendedorId:
                    x.seller?.id ??
                    x.seller_id ??
                    null,
                  link: x.permalink ?? null,
                  status: x.status ?? null
                }))
              : [],
          erro: r.ok
            ? null
            : {
                codigo: r.dados?.error ?? null,
                mensagem: r.dados?.message ?? null,
                retryAfter: r.retryAfter
              }
        };
      } catch (e) {
        resultados[nome] = {
          httpStatus: null,
          erro: {
            tipo: e.name,
            mensagem: "Falha de comunicacao"
          }
        };
      }
    }

    res.json({
      sucesso: true,
      pesquisa: q,
      resultados,
      aviso:
        "Pesquisa de catalogo nao equivale a busca de todos os anuncios de terceiros"
    });
  })
);

// ======================================
// MEUS ANUNCIOS
// ======================================

app.get(
  "/api/ml/meus-anuncios",
  exigirAdmin,
  rotaSegura(async (req, res) => {
    const me = await mlGet("/users/me");

    if (!me.ok) {
      return erroML(res, me, "usuario");
    }

    const limite = limiteValido(
      req.query.limite ?? "10",
      50
    );

    if (!limite) {
      return res.status(400).json({
        sucesso: false,
        erro: "limite entre 1 e 50"
      });
    }

    const r = await mlGet(
      `/users/${me.dados.id}/items/search`,
      { limit: limite }
    );

    if (!r.ok) {
      return erroML(res, r, "meus_anuncios");
    }

    res.json({
      sucesso: true,
      total: r.dados.paging?.total ?? null,
      anuncios:
        Array.isArray(r.dados.results)
          ? r.dados.results
          : []
    });
  })
);

// ======================================
// DETALHES DOS MEUS ANUNCIOS
// ======================================

app.get(
  "/api/ml/anuncios/detalhes",
  exigirAdmin,
  rotaSegura(async (_req, res) => {
    const me = await mlGet("/users/me");

    if (!me.ok) {
      return erroML(res, me, "usuario");
    }

    const idsR = await mlGet(
      `/users/${me.dados.id}/items/search`,
      { limit: 10 }
    );

    if (!idsR.ok) {
      return erroML(res, idsR, "listar_anuncios");
    }

    const ids = (
      Array.isArray(idsR.dados.results)
        ? idsR.dados.results
        : []
    ).filter(itemValido).slice(0, 10);

    if (!ids.length) {
      return res.json({
        sucesso: true,
        total: 0,
        anuncios: []
      });
    }

    const r = await mlGet(
      "/items/bulk",
      { ids: ids.join(",") }
    );

    if (!r.ok) {
      return erroML(res, r, "detalhes_anuncios");
    }

    const itens = Array.isArray(r.dados)
      ? r.dados
      : [];

    res.json({
      sucesso: true,
      total: itens.length,
      anuncios: itens.map(x => ({
        httpStatus: x.status_code ?? null,
        ...resumoItem(x.body || {}),
        id: x.body?.id ?? x.id ?? null
      }))
    });
  })
);


﻿// ======================================
// ANPRICE - TESTE DE USER PRODUCT
// ======================================

app.get(
  "/api/ml/user-product/teste",
  exigirAdmin,
  rotaSegura(async (req, res) => {
    const id =
      typeof req.query.id === "string"
        ? req.query.id.trim().toUpperCase()
        : "";

    if (!/^MLBU\d+$/.test(id)) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe um ID MLBU valido"
      });
    }

    const resultado = await mlGet(
      `/user-products/${id}`
    );

    if (!resultado.ok) {
      return res.status(resultado.status).json({
        sucesso: false,
        recurso: "User Product",
        id,
        httpMercadoLivre: resultado.status,
        erro: resultado.dados?.error ?? null,
        mensagem: resultado.dados?.message ?? null,
        retryAfter: resultado.retryAfter
      });
    }

    return res.json({
      sucesso: true,
      recurso: "User Product",
      id,
      httpMercadoLivre: resultado.status,
      dados: resultado.dados
    });
  })
);


// ======================================
// ANPRICE - BUSCA INTELIGENTE DE PRODUTOS (V1)
// ======================================

app.get(
  "/api/ml/busca-inteligente-v1",
  exigirAdmin,
  rotaSegura(async (req, res) => {
    res.set("Cache-Control", "no-store");

    const q =
      typeof req.query.q === "string"
        ? req.query.q.trim()
        : "";

    const limite = limiteValido(
      req.query.limite ?? "10",
      20
    );

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

    // Normaliza palavras para comparar relevancia.
    function normalizar(texto) {
      return String(texto || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    }

    const palavras = normalizar(q)
      .split(" ")
      .filter(x => x.length > 1);

    // 1. Descobrir o dominio do produto.
    let dominios = [];
    let erroClassificacao = null;

    try {
      const sugestao = await mlGet(
        "/sites/MLB/domain_discovery/search",
        { q, limit: 3 }
      );

      if (
        sugestao.ok &&
        Array.isArray(sugestao.dados)
      ) {
        dominios = [
          ...new Set(
            sugestao.dados
              .map(x => x.domain_id)
              .filter(Boolean)
          )
        ];
      } else {
        erroClassificacao = sugestao.status;
      }
    } catch {
      erroClassificacao = "indisponivel";
    }

    // 2. Buscar candidatos no catalogo.
    // Busca mais candidatos do que o usuario pediu,
    // pois parte deles pode ser irrelevante.
    const quantidadeCandidatos = Math.min(
      40,
      Math.max(20, limite * 3)
    );

    const busca = await mlGet(
      "/products/search",
      {
        site_id: "MLB",
        status: "active",
        q,
        limit: quantidadeCandidatos
      }
    );

    if (!busca.ok) {
      return erroML(
        res,
        busca,
        "busca_inteligente_catalogo"
      );
    }

    const candidatos = Array.isArray(
      busca.dados.results
    )
      ? busca.dados.results
      : [];

    // Pontuacao textual para ordenar candidatos.
    function pontuar(nome) {
      const texto = normalizar(nome);

      let pontos = 0;

      for (const palavra of palavras) {
        if (texto.split(" ").includes(palavra)) {
          pontos += 3;
        } else if (texto.includes(palavra)) {
          pontos += 1;
        }
      }

      if (texto.includes(normalizar(q))) {
        pontos += 5;
      }

      return pontos;
    }

    const candidatosOrdenados = candidatos
      .filter(x => x.id && x.name)
      .map(x => ({
        ...x,
        pontuacao: pontuar(x.name)
      }))
      .filter(x => x.pontuacao > 0)
      .sort((a, b) => b.pontuacao - a.pontuacao);

    // 3. Consultar detalhes e imagens reais.
    const produtos = [];
    const problemas = [];
    const produtosAlternativos = [];

    let consultasDetalhes = 0;
    let interrompido429 = false;
    let descartadosDominio = 0;

    // Lotes pequenos evitam disparar muitas
    // chamadas simultaneas.
    for (
      let inicio = 0;
      inicio < candidatosOrdenados.length &&
      produtos.length < limite;
      inicio += 3
    ) {
      const lote = candidatosOrdenados.slice(
        inicio,
        inicio + 3
      );

      const resultados = await Promise.all(
        lote.map(async candidato => {
          try {
            const r = await mlGet(
              `/products/${candidato.id}`
            );

            return { candidato, resposta: r };
          } catch (e) {
            return {
              candidato,
              erro: e.name
            };
          }
        })
      );

      consultasDetalhes += lote.length;

      for (const resultado of resultados) {
        if (produtos.length >= limite) break;

        if (resultado.erro) {
          problemas.push({
            id: resultado.candidato.id,
            motivo: resultado.erro
          });
          continue;
        }

        const r = resultado.resposta;

        if (r.status === 429) {
          interrompido429 = true;
          problemas.push({
            id: resultado.candidato.id,
            httpMercadoLivre: 429,
            retryAfter: r.retryAfter
          });
          continue;
        }

        if (!r.ok) {
          problemas.push({
            id: resultado.candidato.id,
            httpMercadoLivre: r.status
          });
          continue;
        }

        const produto = resumoProduto(r.dados);

        // Se a API reconheceu um dominio especifico,
        // descarta resultados de outros dominios.
        if (
  dominios.length > 0 &&
  !dominios.includes(produto.dominio)
) {
  descartadosDominio++;

  // Conserva candidatos relevantes como alternativa,
  // em vez de descarta-los definitivamente.
  produtosAlternativos.push({
    ...produto,
    pontuacaoRelevancia: resultado.candidato.pontuacao,
    origem: "CATALOGO_MERCADO_LIVRE",
    correspondenciaDominio: "nao_confirmada",
    comissaoAfiliado: null,
    elegibilidadeAfiliado: "nao_verificada"
  });

  continue;
}

        produtos.push({
          ...produto,
          pontuacaoRelevancia:
            resultado.candidato.pontuacao,
          origem: "CATALOGO_MERCADO_LIVRE",
          comissaoAfiliado: null,
          elegibilidadeAfiliado: "nao_verificada"
        });
      }

      if (interrompido429) break;
    }

    // Se nenhum produto passou pelo filtro de dominio,
// aproveita os candidatos textualmente relevantes.
// Nao inventa resultados.
if (
  produtos.length === 0 &&
  produtosAlternativos.length > 0
) {
  produtos.push(
    ...produtosAlternativos.slice(0, limite)
  );
}

    // 4. Resposta pronta para o frontend.
    return res.json({
      sucesso: true,
      sistema: "AnPrice",
      recurso: "Busca inteligente",

      pesquisa: q,
      site: "MLB",

      classificacao: {
        dominiosIdentificados: dominios,
        erroClassificacao
      },

      totalCatalogo:
        busca.dados.paging?.total ?? null,

      candidatosAnalisados:
        candidatosOrdenados.length,

      consultasDetalhes,
      descartadosDominio,

      limiteSolicitado: limite,
      totalRetornado: produtos.length,

      resultadoParcial: interrompido429,

      produtos,

      diagnostico: {
        problemas,
        observacao:
          "Resultados de catalogo nao garantem anuncio disponivel ou elegibilidade de afiliado"
      },

      consultadoEm: new Date().toISOString()
    });
  })
);

// ======================================
// INTERFACE WEB ANPRICE
// ======================================

// ======================================
// ANPRICE - BUSCA INTELIGENTE 2.0
// A versao anterior continua em /api/ml/busca-inteligente-v1
// ======================================

const { registrarBuscaInteligente } =
  require("./anprice-busca");

registrarBuscaInteligente(app, {
  mlGet,
  exigirAdmin,
  rotaSegura,
  erroML,
  resumoProduto,
  limiteValido
});

const { registrarPainelAnprice } =
  require("./anprice-painel");

registrarPainelAnprice(app);



// ======================================
// ROTA NAO ENCONTRADA
// ======================================

app.use((_req, res) => {
  res.status(404).json({
    erro: "Rota nao encontrada"
  });
});

// ======================================
// INICIAR SERVIDOR
// ======================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Servidor M AnPrice 2.0.0 iniciado na porta ${PORT}`
  );
});
