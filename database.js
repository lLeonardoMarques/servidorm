
const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;

let client;
let conexaoPendente;

async function conectarMongoDB() {
  if (!uri) {
    throw new Error("MONGODB_URI nao configurada");
  }

  if (!client) {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 10
    });
  }

  if (!conexaoPendente) {
    conexaoPendente = client.connect().catch((erro) => {
      conexaoPendente = null;
      throw erro;
    });
  }

  await conexaoPendente;

  return client.db("servidorm_db");
}

async function verificarMongoDB() {
  const db = await conectarMongoDB();

  await db.command({ ping: 1 });

  return true;
}

module.exports = {
  conectarMongoDB,
  verificarMongoDB
};
