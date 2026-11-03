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
function urlMercadoLivre(valor) {
  try {
    const u = new URL(valor);
    if (u.protocol !== "https:") return "";
    if (!(u.hostname === "mercadolivre.com.br" || u.hostname.endsWith(".mercadolivre.com.br"))) return "";
    return u.href;
  } catch { return ""; }
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
  if (item.posicaoRanking) {
    media.append(elemento("span", "rank-badge", `#${item.posicaoRanking} mais vendidos`));
  }
  card.append(media);

  const body = elemento("div", "product-body");
  body.append(elemento("div", "product-domain", String(item.dominio || "Produto").replace(/^MLB-/, "").replaceAll("_", " ")));
  body.append(elemento("h3", "", item.titulo || "Produto sem título"));

  const attrs = Array.isArray(item.atributosPrincipais) ? item.atributosPrincipais : [];
  if (attrs.length) {
    const lista = elemento("div", "product-attrs");
    for (const a of attrs) {
      const chip = elemento("span", "attr-chip", a.valor);
      chip.title = a.nome || "";
      lista.append(chip);
    }
    body.append(lista);
  }

  const motivos = Array.isArray(item.motivos) ? item.motivos.slice(0, 3) : [];
  const alertas = Array.isArray(item.alertas) ? item.alertas.slice(0, 2) : [];
  if (motivos.length || alertas.length) {
    const why = elemento("ul", "product-why");
    for (const m of motivos) why.append(elemento("li", "why-ok", m));
    for (const m of alertas) why.append(elemento("li", "why-warn", m));
    body.append(why);
  }

  const meta = [`ID: ${item.id || "—"}`];
  if (item.variantesAgrupadas > 1) meta.push(`${item.variantesAgrupadas} variantes agrupadas`);
  body.append(elemento("div", "product-id", meta.join(" · ")));
  body.append(elemento("div", "product-divider"));
  const detail = elemento("div", "product-details");
  detail.append(elemento("span", "", "PREÇO / COMISSÃO"));
  detail.append(elemento("strong", "", item.preco != null ? `R$ ${Number(item.preco).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "Não disponíveis"));
  body.append(detail);

  const footer = elemento("div", "product-footer");
  const oferta = urlMercadoLivre(item.linkOferta || "");
  const pesquisa = urlMercadoLivre(item.linkPesquisaOfertas || "");
  if (oferta || pesquisa) {
    const a = elemento("a", "offer-button", oferta ? "Ver oferta ↗" : "Pesquisar ofertas ↗");
    a.href = oferta || pesquisa;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = oferta ? "Anúncio retornado pela API" : "Abre a busca pública do Mercado Livre por este modelo";
    footer.append(a);
  }
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
function renderizar() {
  const grid = $("productGrid");
  grid.replaceChildren();
  $("messageBox").classList.add("hidden");
  if (!state.produtos.length) {
    grid.append(elemento("div", "empty-result", "Nenhum produto relevante encontrado. Experimente um refinamento ou um termo mais específico."));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of state.produtos) frag.append(addCard(p));
  grid.append(frag);
}
function renderizarRefinamentos(lista) {
  const chips = $("refineChips");
  chips.replaceChildren();
  const itens = Array.isArray(lista) ? lista.slice(0, 10) : [];
  $("refineBar").classList.toggle("hidden", itens.length === 0);
  for (const r of itens) {
    const b = elemento("button", "refine-chip", r.rotulo);
    b.type = "button";
    b.title = `Pesquisar: ${r.consulta}`;
    b.addEventListener("click", () => {
      $("searchInput").value = r.consulta;
      pesquisar();
    });
    chips.append(b);
  }
}
async function pesquisar() {
  if (!state.autenticado || state.carregando) return;
  const q = $("searchInput").value.trim();
  const limite = Number($("limitSelect").value);
  if (q.length < 2 || q.length > 100) return;
  state.carregando = true;
  $("searchButton").disabled = true;
  $("searchButton").textContent = "Pesquisando…";
  for (const id of ["statProducts", "statCatalog", "statDiscarded", "statApi"]) $(id).textContent = "—";
  $("queryEcho").textContent = "";
  $("refineBar").classList.add("hidden");
  $("searchAllLink").classList.add("hidden");
  mostrarMensagem("Buscando produtos reais…", "Explorando o catálogo, o ranking da categoria e os modelos relacionados.", "◌");
  try {
    const params = new URLSearchParams({ q, limite: String(limite) });
    const dados = await apiJson(`/painel/api/busca?${params.toString()}`);
    state.produtos = Array.isArray(dados.produtos) ? dados.produtos : [];
    state.pesquisa = q;
    texto($("statProducts"), nf.format(state.produtos.length));
    texto($("statCatalog"), dados.totalCatalogo == null ? "—" : nf.format(dados.totalCatalogo));
    texto($("statDiscarded"), nf.format(dados.descartadosDominio ?? 0));
    const consumo = dados.consumo || {};
    texto($("statApi"), consumo.chamadasApi == null ? "—" : nf.format(consumo.chamadasApi));
    texto($("statApiInfo"), consumo.respostasDoCache ? `${nf.format(consumo.respostasDoCache)} respostas vindas do cache` : "Chamadas à API nesta busca");
    texto($("queryEcho"), `· ${q}`);
    const categoria = dados.classificacao?.nomeCategoria;
    texto($("resultsSubtitle"), `${state.produtos.length} produtos selecionados${categoria ? ` · ${categoria}` : ""} · Imagens originais do catálogo`);
    const linkGeral = urlMercadoLivre(dados.linkPesquisaOfertas || "");
    if (linkGeral) {
      $("searchAllLink").href = linkGeral;
      $("searchAllLink").classList.remove("hidden");
    }
    renderizarRefinamentos(dados.refinamentos);
    renderizar();
    if (dados.resultadoParcial) {
      texto($("resultsSubtitle"), "Resultado parcial: limite de requisições do Mercado Livre atingido. Tente novamente em instantes.");
    } else if (dados.usouAlternativos) {
      texto($("resultsSubtitle"), `${state.produtos.length} produtos com categoria não confirmada · confira os resultados`);
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
