"use strict";

// AnPrice: painel protegido por sessao HTTP-only.
// Instale com registrarPainelAnprice(app) ANTES da rota 404.
// Nenhuma credencial administrativa e enviada ao JavaScript do navegador.
const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");

function assinatura(valor) {
  return crypto.createHash("sha256").update(valor).digest("hex");
}

function compararSeguro(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(String(a)).digest(),
    crypto.createHash("sha256").update(String(b)).digest()
  );
}

function obterCookie(req, nome) {
  const cabecalho = req.headers.cookie || "";
  for (const parte of cabecalho.split(";")) {
    const [chave, ...valor] = parte.trim().split("=");
    if (chave === nome) return valor.join("=");
  }
  return null;
}

function registrarPainelAnprice(app) {
  const SESSAO = "anprice_session";
  const DURACAO = 8 * 60 * 60 * 1000;
  const sessoes = new Map();
  const tentativas = new Map();
  const pasta = path.join(__dirname, "painel");

  // Cabecalhos para as paginas e APIs do painel.
  app.use("/painel", (_req, res, next) => {
    res.set({
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' https://*.mlstatic.com data:",
        "connect-src 'self'",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'"
      ].join("; ")
    });
    next();
  });

  function cookieConfig() {
    return {
      httpOnly: true,
      secure: true, // Render usa HTTPS. Em HTTP local, o login nao persiste.
      sameSite: "strict",
      path: "/painel",
      maxAge: DURACAO
    };
  }

  function sessaoAtual(req) {
    const valor = obterCookie(req, SESSAO);
    if (!valor || !/^[A-Za-z0-9_-]{43}$/.test(valor)) return null;
    const chave = assinatura(valor);
    const registro = sessoes.get(chave);
    if (!registro) return null;
    if (registro.expiresAt < Date.now()) {
      sessoes.delete(chave);
      return null;
    }
    return { chave, registro };
  }

  function exigirSessao(req, res, next) {
    if (!sessaoAtual(req)) {
      return res.status(401).json({
        sucesso: false,
        erro: "Sessao expirada. Faca login novamente."
      });
    }
    next();
  }

  function origemConfiavel(req) {
    const origem = req.get("origin");
    if (!origem) return false;
    try {
      const u = new URL(origem);
      return u.protocol === "https:" && u.host === req.get("host");
    } catch {
      return false;
    }
  }

  function limparExpirados() {
    const agora = Date.now();
    for (const [k, s] of sessoes) {
      if (s.expiresAt <= agora) sessoes.delete(k);
    }
    for (const [k, t] of tentativas) {
      if (t.ate <= agora) tentativas.delete(k);
    }
  }

  app.get("/painel", (_req, res) => {
    res.sendFile(path.join(pasta, "index.html"));
  });

  app.use("/painel/assets", express.static(pasta, {
    index: false,
    dotfiles: "deny",
    etag: false,
    maxAge: 0
  }));

  app.get("/painel/api/sessao", (req, res) => {
    res.json({ autenticado: Boolean(sessaoAtual(req)) });
  });

  app.post("/painel/api/login", (req, res) => {
    if (!origemConfiavel(req)) {
      return res.status(403).json({ erro: "Origem nao permitida" });
    }
    if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
      return res.status(503).json({ erro: "Admin nao configurado" });
    }
    limparExpirados();
    const ip = req.ip || "desconhecido";
    const agora = Date.now();
    const estado = tentativas.get(ip) || { vezes: 0, ate: agora + 15 * 60 * 1000 };
    if (estado.vezes >= 5 && estado.ate > agora) {
      return res.status(429).json({ erro: "Muitas tentativas. Tente mais tarde." });
    }

    const usuario = typeof req.body?.usuario === "string" ? req.body.usuario : "";
    const senha = typeof req.body?.senha === "string" ? req.body.senha : "";
    if (usuario.length > 128 || senha.length > 256) {
      return res.status(400).json({ erro: "Credenciais invalidas" });
    }
    if (
      !compararSeguro(usuario, process.env.ADMIN_USER) ||
      !compararSeguro(senha, process.env.ADMIN_PASSWORD)
    ) {
      tentativas.set(ip, { vezes: estado.vezes + 1, ate: estado.ate });
      return res.status(401).json({ erro: "Usuario ou senha incorretos" });
    }
    tentativas.delete(ip);
    if (sessoes.size >= 500) {
      return res.status(503).json({ erro: "Limite de sessoes atingido" });
    }

    const token = crypto.randomBytes(32).toString("base64url");
    sessoes.set(assinatura(token), { expiresAt: Date.now() + DURACAO });
    res.cookie(SESSAO, token, cookieConfig());
    return res.json({ sucesso: true, autenticado: true });
  });

  app.post("/painel/api/logout", exigirSessao, (req, res) => {
    if (!origemConfiavel(req)) {
      return res.status(403).json({ erro: "Origem nao permitida" });
    }
    const s = sessaoAtual(req);
    if (s) sessoes.delete(s.chave);
    res.clearCookie(SESSAO, {
      ...cookieConfig(),
      maxAge: undefined
    });
    res.json({ sucesso: true });
  });

  // Gateway: somente o SERVIDOR envia Basic Auth ao endpoint ja existente.
  // O navegador nao recebe cabecalhos de autorizacao nem valores secretos.
  app.get("/painel/api/busca", exigirSessao, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const limite = Number(req.query.limite ?? 10);
    if (q.length < 2 || q.length > 100 || !Number.isInteger(limite) || limite < 1 || limite > 20) {
      return res.status(400).json({ sucesso: false, erro: "Pesquisa ou limite invalido" });
    }
    try {
      const porta = Number(process.env.PORT || 3000);
      const url = new URL(`http://127.0.0.1:${porta}/api/ml/busca-inteligente`);
      url.searchParams.set("q", q);
      url.searchParams.set("limite", String(limite));
      if (typeof req.query.dominio === "string" && /^MLB-[A-Z0-9_]{2,60}$/.test(req.query.dominio)) {
        url.searchParams.set("dominio", req.query.dominio);
      }
      if (req.query.explorar === "0") url.searchParams.set("explorar", "0");
      const credencial = Buffer.from(
        `${process.env.ADMIN_USER}:${process.env.ADMIN_PASSWORD}`,
        "utf8"
      ).toString("base64");
      const resposta = await fetch(url, {
        headers: {
          Authorization: `Basic ${credencial}`,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(120000)
      });
      const texto = await resposta.text();
      if (texto.length > 2_000_000) {
        return res.status(502).json({ sucesso: false, erro: "Resposta da API excedeu o limite" });
      }
      let dados;
      try { dados = JSON.parse(texto); }
      catch { dados = { sucesso: false, erro: "Resposta inesperada da API" }; }
      return res.status(resposta.status).json(dados);
    } catch (erro) {
      console.error("AnPrice gateway:", erro.name);
      return res.status(502).json({
        sucesso: false,
        erro: "Nao foi possivel consultar a busca inteligente"
      });
    }
  });
}

module.exports = { registrarPainelAnprice };
