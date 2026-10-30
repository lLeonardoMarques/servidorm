
const express = require("express");
const crypto = require("node:crypto");
const {
  conectarMongoDB,
  verificarMongoDB
} = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================
// CONFIGURACOES
// ======================================

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI = process.env.ML_REDIRECT_URI;
const OAUTH_KEY = process.env.ML_OAUTH_KEY;
const TOKEN_KEY = process.env.ML_TOKEN_KEY;

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const COOKIE = "ml_oauth";
const TOKEN_ID = "primary";

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// ======================================
// SEGURANCA
// ======================================

function chaveValida(chave) {
  return (
    typeof chave === "string" &&
    /^[a-f0-9]{64}$/i.test(chave)
  );
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
  const hashA = crypto
    .createHash("sha256")
    .update(String(a))
    .digest();

  const hashB = crypto
    .createHash("sha256")
    .update(String(b))
    .digest();

  return crypto.timingSafeEqual(hashA, hashB);
}

// Autenticacao administrativa
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
        header.slice(6),
        "base64"
      ).toString("utf8");

      const separador = texto.indexOf(":");

      if (separador !== -1) {
        const usuario = texto.slice(0, separador);
        const senha = texto.slice(separador + 1);

        if (
          compararSeguro(usuario, ADMIN_USER) &&
          compararSeguro(senha, ADMIN_PASSWORD)
        ) {
          return next();
        }
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

  const conteudo = Buffer.concat([
    cifra.update(JSON.stringify(dados), "utf8"),
    cifra.final()
  ]);

  return Buffer.concat([
    iv,
    cifra.getAuthTag(),
    conteudo
  ]).toString("base64url");
}

function descriptografar(token, chaveHex) {
  const buffer = Buffer.from(token, "base64url");

  if (buffer.length < 29) {
    throw new Error("Dados criptografados invalidos");
  }

  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const conteudo = buffer.subarray(28);

  const decifra = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(chaveHex, "hex"),
    iv
  );

  decifra.setAuthTag(tag);

  return JSON.parse(
    Buffer.concat([
      decifra.update(conteudo),
      decifra.final()
    ]).toString("utf8")
  );
}

// ======================================
// COOKIES OAUTH
// ======================================

function lerCookie(req, nome) {
  const cookies = (req.headers.cookie || "")
    .split(";");

  for (const cookie of cookies) {
    const [chave, ...valor] = cookie
      .trim()
      .split("=");

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
// BANCO DE DADOS
// ======================================

async function colecaoTokens() {
  const db = await conectarMongoDB();
  return db.collection("ml_tokens");
}

function prepararTokens(dados) {
  if (!dados.access_token || !dados.refresh_token) {
    throw new Error("Tokens incompletos");
  }

  const duracao = Number(dados.expires_in);

  if (!Number.isFinite(duracao) || duracao <= 0) {
    throw new Error("Validade do token invalida");
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

  const conteudo = criptografar(
    tokens,
    TOKEN_KEY
  );

  await colecao.updateOne(
    { _id: TOKEN_ID },
    {
      $set: {
        conteudo,
        usuarioId: tokens.user_id,
        atualizadoEm: new Date()
      }
    },
    { upsert: true }
  );
}

async function carregarTokens() {
  const colecao = await colecaoTokens();

  const documento = await colecao.findOne({
    _id: TOKEN_ID
  });

  if (!documento) {
    return null;
  }

  return descriptografar(
    documento.conteudo,
    TOKEN_KEY
  );
}

// ======================================
// COMUNICACAO MERCADO LIVRE
// ======================================

async function solicitarToken(parametros) {
  const resposta = await fetch(
    "https://api.mercadolibre.com/oauth/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams(parametros),
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!resposta.ok) {
    const erro = new Error(
      "Falha no OAuth Mercado Livre"
    );

    erro.statusMercadoLivre = resposta.status;
    throw erro;
  }

  return resposta.json();
}

async function consultarUsuario(accessToken) {
  const resposta = await fetch(
    "https://api.mercadolibre.com/users/me",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!resposta.ok) {
    const erro = new Error(
      "Falha na consulta de usuario"
    );

    erro.statusMercadoLivre = resposta.status;
    throw erro;
  }

  return resposta.json();
}

// ======================================
// RENOVACAO AUTOMATICA DE TOKENS
// ======================================

let renovacaoPendente = null;

async function renovarTokens() {
  const atuais = await carregarTokens();

  if (!atuais?.refresh_token) {
    throw new Error("Conta nao conectada");
  }

  const resposta = await solicitarToken({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: atuais.refresh_token
  });

  const novos = prepararTokens(resposta);

  await salvarTokens(novos);

  return novos;
}

async function obterAccessToken(
  forcarRenovacao = false
) {
  if (!configurado()) {
    throw new Error("Configuracao incompleta");
  }

  const tokens = await carregarTokens();

  if (!tokens) {
    throw new Error("Conta nao conectada");
  }

  const margem = 120000;

  if (
    !forcarRenovacao &&
    tokens.expires_at > Date.now() + margem
  ) {
    return tokens.access_token;
  }

  if (!renovacaoPendente) {
    renovacaoPendente = renovarTokens()
      .finally(() => {
        renovacaoPendente = null;
      });
  }

  const novos = await renovacaoPendente;

  return novos.access_token;
}

// ======================================
// ROTAS DE STATUS
// ======================================

app.get("/", (req, res) => {
  res.json({
    projeto: "Servidor M",
    sistema: "AnPrice - Mercado Livre",
    versao: "1.4.0",
    status: "online"
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    servidor: "online",
    versao: "1.4.0",
    timestamp: new Date().toISOString()
  });
});

// ======================================
// STATUS MONGODB
// ======================================

app.get(
  "/api/db/status",
  exigirAdmin,
  async (req, res) => {
    try {
      await verificarMongoDB();

      return res.json({
        sucesso: true,
        banco: "MongoDB Atlas",
        conexao: "online"
      });
    } catch (erro) {
      console.error("MongoDB:", {
        nome: erro.name,
        codigo: erro.code ?? null,
        codigoMongo: erro.codeName ?? null
      });

      return res.status(503).json({
        sucesso: false,
        conexao: "indisponivel"
      });
    }
  }
);

// ======================================
// STATUS MERCADO LIVRE
// ======================================

app.get(
  "/api/ml/status",
  exigirAdmin,
  async (req, res) => {
    if (!configurado()) {
      return res.status(503).json({
        configurado: false
      });
    }

    try {
      const tokens = await carregarTokens();

      return res.json({
        configurado: true,
        conectado: Boolean(tokens),
        usuarioId: tokens?.user_id ?? null,
        tokenValidoAte: tokens
          ? new Date(tokens.expires_at).toISOString()
          : null,
        armazenamento: "MongoDB Atlas criptografado"
      });
    } catch {
      return res.status(503).json({
        erro: "Nao foi possivel consultar a conexao"
      });
    }
  }
);

// ======================================
// INICIAR AUTORIZACAO OAUTH PKCE
// ======================================

app.get(
  "/api/ml/auth",
  exigirAdmin,
  (req, res) => {
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

    const sessao = criptografar({
      verifier,
      state,
      criadoEm: Date.now()
    }, OAUTH_KEY);

    res.cookie(COOKIE, sessao, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/ml",
      maxAge: 600000
    });

    const url = new URL(
      "https://auth.mercadolivre.com.br/authorization"
    );

    url.searchParams.set(
      "response_type",
      "code"
    );
    url.searchParams.set(
      "client_id",
      CLIENT_ID
    );
    url.searchParams.set(
      "redirect_uri",
      REDIRECT_URI
    );
    url.searchParams.set(
      "code_challenge",
      challenge
    );
    url.searchParams.set(
      "code_challenge_method",
      "S256"
    );
    url.searchParams.set(
      "state",
      state
    );

    return res.redirect(url.toString());
  }
);

// ======================================
// CALLBACK OAUTH
// ======================================

app.get(
  "/api/ml/callback",
  async (req, res) => {
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
      sessao = descriptografar(
        cookie,
        OAUTH_KEY
      );

      const agora = Date.now();

      if (
        typeof sessao.criadoEm !== "number" ||
        agora - sessao.criadoEm > 600000 ||
        sessao.criadoEm > agora ||
        typeof req.query.state !== "string" ||
        !compararSeguro(
          req.query.state,
          sessao.state
        )
      ) {
        throw new Error("Sessao invalida");
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

      const usuario = await consultarUsuario(
        tokens.access_token
      );

      if (
        String(usuario.id) !==
        String(tokens.user_id)
      ) {
        throw new Error("Identidade divergente");
      }

      await salvarTokens(tokens);

      return res.json({
        sucesso: true,
        mensagem: "Mercado Livre conectado!",
        usuario: {
          id: usuario.id,
          nickname: usuario.nickname
        },
        armazenamento: "MongoDB Atlas criptografado"
      });

    } catch (erro) {
      console.error("OAuth Mercado Livre:", {
        nome: erro.name,
        httpMercadoLivre:
          erro.statusMercadoLivre || null
      });

      return res.status(502).json({
        erro: "Falha na autenticacao ou persistencia",
        httpMercadoLivre:
          erro.statusMercadoLivre || null
      });
    }
  }
);

// ======================================
// CONSULTAR CONTA
// ======================================

app.get(
  "/api/ml/me",
  exigirAdmin,
  async (req, res) => {
    try {
      let token = await obterAccessToken();
      let usuario;

      try {
        usuario = await consultarUsuario(token);
      } catch (erro) {
        if (erro.statusMercadoLivre !== 401) {
          throw erro;
        }

        token = await obterAccessToken(true);
        usuario = await consultarUsuario(token);
      }

      return res.json({
        sucesso: true,
        usuario: {
          id: usuario.id,
          nickname: usuario.nickname,
          site_id: usuario.site_id,
          seller_reputation:
            usuario.seller_reputation
        }
      });

    } catch (erro) {
      console.error("Consulta Mercado Livre:", {
        nome: erro.name,
        httpMercadoLivre:
          erro.statusMercadoLivre || null
      });

      return res.status(502).json({
        sucesso: false,
        erro: "Falha ao consultar conta",
        httpMercadoLivre:
          erro.statusMercadoLivre || null
      });
    }
  }
);

// ======================================
// NOVO: PESQUISA DE PRODUTOS E ANUNCIOS
// ======================================

app.get(
  "/api/ml/pesquisa-teste",
  exigirAdmin,
  async (req, res) => {
    const q = typeof req.query.q === "string"
      ? req.query.q.trim()
      : "";

    if (!q || q.length > 100) {
      return res.status(400).json({
        sucesso: false,
        erro: "Informe q com ate 100 caracteres"
      });
    }

    try {
      const token = await obterAccessToken();

      const catalogo = new URL(
        "https://api.mercadolibre.com/products/search"
      );

      catalogo.searchParams.set(
        "site_id", "MLB"
      );
      catalogo.searchParams.set(
        "status", "active"
      );
      catalogo.searchParams.set("q", q);
      catalogo.searchParams.set("limit", "10");

      const anuncios = new URL(
        "https://api.mercadolibre.com/sites/MLB/search"
      );

      anuncios.searchParams.set("q", q);
      anuncios.searchParams.set("limit", "10");

      const consultas = [
        { nome: "catalogo", url: catalogo },
        { nome: "anuncios", url: anuncios }
      ];

      const resultados = {};

      for (const consulta of consultas) {
        try {
          const resposta = await fetch(
            consulta.url.toString(),
            {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json"
              },
              signal: AbortSignal.timeout(15000)
            }
          );

          // Respostas de erro podem nao ser JSON.
          const tipo = resposta.headers.get(
            "content-type"
          ) || "";

          const dados = tipo.includes("application/json")
            ? await resposta.json()
            : {};

          resultados[consulta.nome] = {
            httpStatus: resposta.status,
            total: dados.paging?.total ?? null,

            produtos:
              resposta.ok &&
              Array.isArray(dados.results)
                ? dados.results.slice(0, 10).map(
                    item => ({
                      id: item.id ?? null,
                      nome:
                        item.name ||
                        item.title ||
                        null,
                      preco: item.price ?? null,
                      moeda:
                        item.currency_id ?? null,
                      vendedorId:
                        item.seller?.id ??
                        item.seller_id ??
                        null,
                      link:
                        item.permalink ?? null,
                      status:
                        item.status ?? null
                    })
                  )
                : [],

            erro: resposta.ok
              ? null
              : {
                  codigo: dados.error ?? null,
                  mensagem: dados.message ?? null
                }
          };

        } catch (erro) {
          resultados[consulta.nome] = {
            httpStatus: null,
            erro: {
              tipo: erro.name,
              mensagem:
                "Falha de comunicacao com a API"
            }
          };
        }
      }

      return res.json({
        sucesso: true,
        pesquisa: q,
        site: "MLB",
        resultados
      });

    } catch (erro) {
      console.error("Pesquisa Mercado Livre:", {
        nome: erro.name,
        httpMercadoLivre:
          erro.statusMercadoLivre || null
      });

      return res.status(502).json({
        sucesso: false,
        erro: "Falha ao obter autenticacao",
        httpMercadoLivre:
          erro.statusMercadoLivre || null
      });
    }
  }
);


﻿// ======================================
// CONSULTAR ANUNCIOS DO VENDEDOR
// ======================================

app.get("/api/ml/meus-anuncios", exigirAdmin, async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const token = await obterAccessToken();

    const url = new URL(
      "https://api.mercadolibre.com/users/136668760/items/search"
    );

    url.searchParams.set("limit", "10");

    const resposta = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });

    const texto = await resposta.text();

    let dados;

    try {
      dados = JSON.parse(texto);
    } catch {
      dados = {};
    }

    return res.status(resposta.status).json({
      sucesso: resposta.ok,
      endpoint: "Meus anuncios",
      httpMercadoLivre: resposta.status,
      total: dados.paging?.total ?? null,
      anuncios: Array.isArray(dados.results)
        ? dados.results.slice(0, 10)
        : [],
      erro: resposta.ok
        ? null
        : {
            codigo: dados.error ?? null,
            mensagem: dados.message ?? null
          },
      retryAfter: resposta.headers.get("retry-after")
    });

  } catch (erro) {
    console.error("Erro ao consultar anuncios:", erro.name);

    return res.status(502).json({
      sucesso: false,
      erro: "Falha na consulta de anuncios"
    });
  }
});


﻿// ======================================
// DETALHES DOS MEUS ANUNCIOS
// ======================================

app.get("/api/ml/anuncios/detalhes", exigirAdmin, async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const token = await obterAccessToken();

    // Buscar IDs de anuncios da conta conectada
    const usuario = await consultarUsuario(token);

    const busca = await fetch(
      `https://api.mercadolibre.com/users/${usuario.id}/items/search?limit=10`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!busca.ok) {
      return res.status(502).json({
        sucesso: false,
        etapa: "listar_anuncios",
        httpMercadoLivre: busca.status
      });
    }

    const listagem = await busca.json();
    const ids = Array.isArray(listagem.results)
      ? listagem.results.filter(
          id => /^MLB\d+$/.test(id)
        ).slice(0, 10)
      : [];

    if (ids.length === 0) {
      return res.json({
        sucesso: true,
        total: 0,
        anuncios: []
      });
    }

    // Consultar os anuncios em lote
    const url = new URL(
      "https://api.mercadolibre.com/items/bulk"
    );

    url.searchParams.set("ids", ids.join(","));

    const resposta = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });

    const dados = await resposta.json();

    if (!resposta.ok) {
      return res.status(502).json({
        sucesso: false,
        etapa: "detalhes_anuncios",
        httpMercadoLivre: resposta.status,
        erro: dados.error ?? null
      });
    }

    const itens = Array.isArray(dados) ? dados : [];

    return res.json({
      sucesso: true,
      total: itens.length,
      anuncios: itens.map(resultado => {
        const item = resultado.body || {};

        return {
          id: resultado.id || item.id || null,
          httpStatus: resultado.status_code ?? null,
          titulo: item.title ?? null,
          precoReferencia: item.price ?? null,
          moeda: item.currency_id ?? null,
          vendedorId: item.seller_id ?? null,
          status: item.status ?? null,
          quantidadeDisponivel:
            item.available_quantity ?? null,
          link: item.permalink ?? null,
          imagem: item.thumbnail ?? null
        };
      })
    });

  } catch (erro) {
    console.error("Detalhes de anuncios:", erro.name);

    return res.status(502).json({
      sucesso: false,
      erro: "Falha ao consultar detalhes dos anuncios"
    });
  }
});



// ======================================
// ROTA INEXISTENTE
// ======================================

app.use((req, res) => {
  res.status(404).json({
    erro: "Rota nao encontrada"
  });
});

// ======================================
// INICIAR SERVIDOR
// ======================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Servidor M v1.4.0 iniciado na porta ${PORT}`
  );
});
