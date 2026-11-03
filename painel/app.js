"use strict";

const $ = id => document.getElementById(id);
const state = { autenticado: false, produtos: [], pesquisa: "", carregando: false };
const nf = new Intl.NumberFormat("pt-BR");

function texto(el, valor) { el.textContent = valor; }
function mostrarMensagem(titulo, descricao, simbolo = "⌕") {
  $("messageBox").classList.remove("hidden");
  $("messageBox").replaceChildren();
  const i = document.createElement("span"); i.className = "message-symbol"; i.textContent = simbolo;
  const b = document.createElement("strong"); b.textContent = titulo;
  const p = document.createElement("p"); p.textContent = descricao;
  $("messageBox").append(i, b, p);
  $("productGrid").replaceChildren();
}
function apiJson(url, opcoes = {}) {
  return fetch(url, { credentials: "same-origin", cache: "no-store", ...opcoes }).then(async r => {
    let dados;
    try { dados = await r.json(); } catch { dados = { erro: "Resposta inesperada do servidor" }; }
    if (!r.ok) {
      const erro = new Error(dados.erro || dados.mensagem || `Erro ${r.status}`);
      erro.status = r.status;
      throw erro;
    }
    return dados;
  });
}
function autenticarVisual(autenticado) {
  state.autenticado = autenticado;
  $("loginOverlay").classList.toggle("hidden", autenticado);
  $("logoutButton").classList.toggle("hidden", !autenticado);
  if (!autenticado) {
    state.produtos = [];
    mostrarMensagem("Acesso necessário", "Entre com suas credenciais para consultar o catálogo.", "⌕");
  }
}

function urlImagem(valor) {
  try {
    const u = new URL(valor);
    if (u.protocol !== "https:") return "";
    if (!(u.hostname === "mlstatic.com" || u.hostname.endsWith(".mlstatic.com"))) return "";
    return u.href;
  } catch { return ""; }
}
function elemento(tag, classe, conteudo) {
  const el = document.createElement(tag);
  if (classe) el.className = classe;
  if (conteudo !== undefined) el.textContent = String(conteudo);
  return el;
}
function detectarModelo(nome) {
  const t = String(nome || "").toLowerCase();
  if (/\b(exposi[cç][aã]o|vitrine)\b/.test(t)) return "exposicao";
  if (/\bs23\s*(ultra)\b/.test(t)) return "ultra";
  if (/\bs23\s*(fe)\b/.test(t)) return "fe";
  if (/\bs23\s*(plus|\+)\b/.test(t)) return "plus";
  if (/\bs23\b/.test(t)) return "base";
  return "outros";
}
function addCard(item) {
  const card = elemento("article", "product");
  const media = elemento("div", "product-media");
  const imagem = urlImagem(item.imagem);
  if (imagem) {
    const img = document.createElement("img");
    img.src = imagem;
    img.alt = item.titulo || "Foto do produto";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    media.append(img);
  } else {
    media.append(elemento("div", "product-placeholder", "▧"));
  }
  media.append(elemento("span", "product-label", "CATÁLOGO OFICIAL"));
  card.append(media);

  const body = elemento("div", "product-body");
  body.append(elemento("div", "product-domain", String(item.dominio || "Produto").replace(/^MLB-/, "").replaceAll("_", " ")));
  body.append(elemento("h3", "", item.titulo || "Produto sem título"));
  body.append(elemento("div", "product-id", `ID: ${item.id || "—"}`));
  body.append(elemento("div", "product-divider"));
  const detail = elemento("div", "product-details");
  detail.append(elemento("span", "PREÇO / COMISSÃO"));
  detail.append(elemento("strong", "", "Não disponíveis"));
  body.append(detail);

  const footer = elemento("div", "product-footer");
  const copiar = elemento("button", "outline-button", "Copiar ID");
  copiar.type = "button";
  copiar.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(String(item.id || ""));
      copiar.textContent = "ID copiado ✓";
      setTimeout(() => { copiar.textContent = "Copiar ID"; }, 1800);
    } catch { copiar.textContent = "Não foi possível copiar"; }
  });
  footer.append(copiar);
  const verFoto = elemento("button", "image-button", "↗");
  verFoto.type = "button";
  verFoto.title = imagem ? "Abrir imagem original" : "Imagem indisponível";
  verFoto.disabled = !imagem;
  verFoto.addEventListener("click", () => {
    if (imagem) window.open(imagem, "_blank", "noopener,noreferrer");
  });
  footer.append(verFoto);
  body.append(footer);
  card.append(body);
  return card;
}
function aplicarFiltros() {
  const filtro = $("modelSelect").value;
  const buscaS23 = /\bs23\b/i.test(state.pesquisa);
  const filtrados = state.produtos.filter(p =>
    filtro === "todos" || !buscaS23 || detectarModelo(p.titulo) === filtro
  );
  const grid = $("productGrid");
  grid.replaceChildren();
  $("messageBox").classList.add("hidden");
  if (!filtrados.length) {
    grid.append(elemento("div", "empty-result", "Nenhum produto corresponde a este filtro. Experimente 'Todos os modelos'."));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of filtrados) frag.append(addCard(p));
  grid.append(frag);
}
async function pesquisar() {
  if (!state.autenticado || state.carregando) return;
  const q = $("searchInput").value.trim();
  const limite = Number($("limitSelect").value);
  if (q.length < 2 || q.length > 100) return;
  state.carregando = true;
  $("searchButton").disabled = true;
  $("searchButton").textContent = "Pesquisando…";
  $("statProducts").textContent = "—";
  $("statCatalog").textContent = "—";
  $("statDiscarded").textContent = "—";
  $("queryEcho").textContent = "";
  mostrarMensagem("Buscando produtos reais…", "Analisando resultados e consultando as imagens do catálogo do Mercado Livre.", "◌");
  try {
    const params = new URLSearchParams({ q, limite: String(limite) });
    const dados = await apiJson(`/painel/api/busca?${params.toString()}`);
    state.produtos = Array.isArray(dados.produtos) ? dados.produtos : [];
    state.pesquisa = q;
    $("modelSelect").disabled = !/\bs23\b/i.test(q);
    $("modelSelect").value = "todos";
    texto($("statProducts"), nf.format(state.produtos.length));
    texto($("statCatalog"), dados.totalCatalogo == null ? "—" : nf.format(dados.totalCatalogo));
    texto($("statDiscarded"), nf.format(dados.descartadosDominio ?? 0));
    texto($("queryEcho"), `· ${q}`);
    texto($("resultsSubtitle"), `${state.produtos.length} produtos selecionados · Imagens originais quando disponíveis`);
    aplicarFiltros();
    if (dados.resultadoParcial) {
      texto($("resultsSubtitle"), "Resultado parcial: limite de requisições do Mercado Livre atingido.");
    }
  } catch (erro) {
    state.produtos = [];
    if (erro.status === 401) {
      autenticarVisual(false);
      $("loginError").textContent = "Sua sessão expirou. Entre novamente.";
      $("loginError").classList.remove("hidden");
    } else {
      mostrarMensagem("Não foi possível concluir a pesquisa", erro.message || "Erro desconhecido", "!");
    }
  } finally {
    state.carregando = false;
    $("searchButton").disabled = false;
    $("searchButton").replaceChildren(document.createTextNode("Buscar produtos "), elemento("span", "", "→"));
  }
}

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginButton").disabled = true;
  $("loginError").classList.add("hidden");
  try {
    await apiJson("/painel/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usuario: $("loginUser").value,
        senha: $("loginPassword").value
      })
    });
    $("loginPassword").value = "";
    $("loginUser").value = "";
    autenticarVisual(true);
    await pesquisar();
  } catch (erro) {
    $("loginPassword").value = "";
    $("loginError").textContent = erro.message;
    $("loginError").classList.remove("hidden");
  } finally { $("loginButton").disabled = false; }
});
$("logoutButton").addEventListener("click", async () => {
  try { await apiJson("/painel/api/logout", { method: "POST" }); }
  catch { /* Sessao ja pode estar expirada */ }
  autenticarVisual(false);
});
$("searchForm").addEventListener("submit", e => { e.preventDefault(); pesquisar(); });
$("modelSelect").addEventListener("change", aplicarFiltros);
for (const botao of document.querySelectorAll("[data-search]")) {
  botao.addEventListener("click", () => {
    $("searchInput").value = botao.dataset.search;
    if (state.autenticado) pesquisar();
  });
}

(async () => {
  try {
    const dados = await apiJson("/painel/api/sessao");
    autenticarVisual(Boolean(dados.autenticado));
    if (dados.autenticado) await pesquisar();
  } catch { autenticarVisual(false); }
})();
