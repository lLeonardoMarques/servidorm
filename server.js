
const express = require("express");

const app = express();
const PORT = 3000;

// Permite receber dados em JSON
app.use(express.json());

// Rota principal: verificar se o servidor está funcionando
app.get("/", (req, res) => {
  res.json({
    status: "online",
    mensagem: "Servidor AnPrice funcionando!",
    sistema: "Integração Mercado Livre"
  });
});

// Rota de teste da API
app.get("/api/status", (req, res) => {
  res.json({
    servidor: "online",
    mercadoLivre: "aguardando configuração"
  });
});

// Rota para futura autenticação OAuth do Mercado Livre
app.get("/callback", (req, res) => {
  if (req.query.error) {
    return res.status(400).json({
      erro: "Autorização recusada"
    });
  }

  if (!req.query.code) {
    return res.status(400).json({
      erro: "Código de autorização não recebido"
    });
  }

  res.json({
    sucesso: true,
    mensagem: "Código de autorização recebido"
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
