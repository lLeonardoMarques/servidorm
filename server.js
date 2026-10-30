
const express = require("express");
const crypto = require("node:crypto");
const { verificarMongoDB } = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

// Configuracoes Mercado Livre
const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI = process.env.ML_REDIRECT_URI;
const OAUTH_KEY = process.env.ML_OAUTH_KEY;

app.disable("x-powered-by");
app.use(express.json());

// ========================================
// CONFIGURACAO DO MERCADO LIVRE
// ========================================

function configurado() {
  return Boolean(
    CLIENT_ID &&
    CLIENT_SECRET &&
    REDIRECT_URI &&
    OAUTH_KEY &&
    /^[a-f0-9]{64}$/i.test(OAUTH_KEY)
  );
}

// ========================================
// CRIPTOGRAFIA DA SESSAO OAUTH
// ========================================

function criarSessao(data) {
  const iv = crypto.randomBytes(12);
  const chave = Buffer.from(OAUTH_KEY, "hex");

  const cifra = crypto.createCipheriv(
    "aes-256-gcm",
    chave,
    iv
  );

  const conteudo = Buffer.concat([
    cifra.update(JSON.stringify(data), "utf8"),
    cifra.final()
  ]);

  return Buffer.concat([
    iv,
    cifra.getAuthTag(),
    conteudo
  ]).toString("base64url");
}

function lerSessao(token) {
  const buffer = Buffer.from(token, "base64url");

  if (buffer.length < 29) {
    throw new Error("Sessao invalida");
  }

  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const dados = buffer.subarray(28);

  const decifra = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(OAUTH_KEY, "hex"),
    iv
  );

  decifra.setAuthTag(tag);

  return JSON.parse(
    Buffer.concat([
      decifra.update(dados),
      decifra.final()
    ]).toString("utf8")
  );
}

// ========================================
// CONTROLE DE COOKIES
// ========================================

function lerCookie(req, nome) {
  const cookies = (req.headers.cookie || "").split(";");

  for (const cookie of cookies) {
    const [chave, ...partes] = cookie.trim().split("=");

    if (chave === nome) {
      return partes.join("=");
    }
  }

  return null;
}

const COOKIE = "ml_oauth";

function limparCookie(res) {
  res.clearCookie(COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/ml"
  });
}

// ========================================
// ROTA PRINCIPAL
// ========================================

app.get("/", (req, res) => {
  res.json({
    projeto: "Servidor M",
    sistema: "AnPrice - Mercado Livre",
    versao: "1.2.0",
    status: "online"
  });
});

// ========================================
// STATUS GERAL DO SERVIDOR
// ========================================

app.get("/api/status", (req, res) => {
  res.json({
    servidor: "online",
    mercadoLivre: "OAuth disponivel",
    mongodb: "rota de diagnostico disponivel",
    versao: "1.2.0",
    timestamp: new Date().toISOString()
  });
});

// ========================================
// STATUS DE CONFIGURACAO MERCADO LIVRE
// ========================================

app.get("/api/ml/status", (req, res) => {
  res.json({
    configurado: configurado(),
    oauth: "PKCE",
    tokenPersistente: false
  });
});

// ========================================
// STATUS DO MONGODB ATLAS
// ========================================

app.get("/api/db/status", async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    await verificarMongoDB();

    return res.json({
      sucesso: true,
      banco: "MongoDB Atlas",
      conexao: "online"
    });

  } catch (erro) {
    console.error(
      "Falha na verificacao MongoDB:",
      erro.name
    );

    return res.status(503).json({
      sucesso: false,
      banco: "MongoDB Atlas",
      conexao: "indisponivel"
    });
  }
});

// ========================================
// INICIAR AUTORIZACAO MERCADO LIVRE
// ========================================

app.get("/api/ml/auth", (req, res) => {
  if (!configurado()) {
    return res.status(503).json({
      erro: "Configuracao OAuth incompleta"
    });
  }

  // Gerar PKCE
  const verifier = crypto
    .randomBytes(32)
    .toString("base64url");

  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  // Protecao contra CSRF
  const state = crypto
    .randomBytes(24)
    .toString("hex");

  const sessao = criarSessao({
    verifier,
    state,
    criadoEm: Date.now()
  });

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

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return res.redirect(url.toString());
});

// ========================================
// CALLBACK MERCADO LIVRE
// ========================================

app.get("/api/ml/callback", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const tokenSessao = lerCookie(req, COOKIE);

  limparCookie(res);

  if (!configurado() || !tokenSessao) {
    return res.status(400).json({
      erro: "Sessao OAuth ausente ou configuracao incompleta"
    });
  }

  let sessao;

  try {
    sessao = lerSessao(tokenSessao);

    const agora = Date.now();

    if (
      !sessao.criadoEm ||
      agora - sessao.criadoEm > 600000 ||
      sessao.criadoEm > agora ||
      typeof req.query.state !== "string" ||
      req.query.state !== sessao.state
    ) {
      throw new Error("Estado invalido ou expirado");
    }

  } catch {
    return res.status(400).json({
      erro: "Sessao OAuth invalida ou expirada"
    });
  }

  if (req.query.error) {
    return res.status(400).json({
      erro: "Autorizacao recusada pelo Mercado Livre"
    });
  }

  if (typeof req.query.code !== "string") {
    return res.status(400).json({
      erro: "Codigo de autorizacao ausente"
    });
  }

  try {
    // Trocar codigo por Access Token
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: req.query.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: sessao.verifier
    });

    const resposta = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: params,
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!resposta.ok) {
      return res.status(502).json({
        erro: "Falha na troca do codigo por token",
        httpMercadoLivre: resposta.status
      });
    }

    const dados = await resposta.json();

    if (!dados.access_token) {
      return res.status(502).json({
        erro: "Mercado Livre nao retornou access_token"
      });
    }

    // Consultar a conta autenticada
    const usuarioResposta = await fetch(
      "https://api.mercadolibre.com/users/me",
      {
        headers: {
          Authorization: `Bearer ${dados.access_token}`
        },
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!usuarioResposta.ok) {
      return res.status(502).json({
        erro: "Token recebido, mas consulta da conta falhou",
        httpMercadoLivre: usuarioResposta.status
      });
    }

    const usuario = await usuarioResposta.json();

    // Nesta versao, os tokens nao sao salvos.
    // Vamos implementar persistencia criptografada
    // no MongoDB na proxima etapa.

    return res.json({
      sucesso: true,
      mensagem: "Mercado Livre autenticado com sucesso!",
      usuario: {
        id: usuario.id,
        nickname: usuario.nickname
      },
      armazenamento: "Tokens descartados apos o teste",
      banco: "MongoDB Atlas preparado"
    });

  } catch (erro) {
    console.error(
      "Falha na autenticacao Mercado Livre:",
      erro.name
    );

    return res.status(502).json({
      erro: "Falha de comunicacao com Mercado Livre"
    });
  }
});

// ========================================
// ROTA NAO ENCONTRADA
// ========================================

app.use((req, res) => {
  res.status(404).json({
    erro: "Rota nao encontrada"
  });
});

// ========================================
// INICIAR SERVIDOR
// ========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor M iniciado na porta ${PORT}`);
});
