"use strict";

// ======================================================
// AnPrice 2.1 — painel
// Sem innerHTML com dados externos: tudo via textContent.
// ======================================================

const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat("pt-BR");
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const state = {
  autenticado: false,
  produtos: [],
  pesquisa: "",
  classificacao: null,
  carregando: false,
  modo: "afiliado",
  compare: [],
  historico: [],
  produtoAberto: null
};

// ---------------- utilidades ----------------
function guardar(chave, valor) { try { localStorage.setItem("anprice_" + chave, JSON.stringify(valor)); } catch { /* sem storage */ } }
function ler(chave, padrao) { try { const v = localStorage.getItem("anprice_" + chave); return v ? JSON.parse(v) : padrao; } catch { return padrao; } }
function el(tag, classe, conteudo) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (conteudo !== undefined && conteudo !== null) e.textContent = String(conteudo);
  return e;
}
function dinheiro(v) { return typeof v === "number" && Number.isFinite(v) ? brl.format(v) : "—"; }
function texto(e, v) { e.textContent = v; }
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}
function urlImagem(valor) {
  try {
    const u = new URL(valor);
    if (u.protocol !== "https:") return "";
    if (!(u.hostname === "mlstatic.com" || u.hostname.endsWith(".mlstatic.com"))) return "";
    return u.href;
  } catch { return ""; }
}
function urlMercadoLivre(valor) {
  try {
    const u = new URL(valor);
    if (u.protocol !== "https:") return "";
    const h = u.hostname;
    const ok = ["mercadolivre.com.br", "mercadolibre.com"].some(d => h === d || h.endsWith("." + d));
    return ok ? u.href : "";
  } catch { return ""; }
}
function imagem(src, alt, classe) {
  const url = urlImagem(src || "");
  if (!url) return el("div", "product-placeholder", "▧");
  const i = document.createElement("img");
  i.src = url;
  i.alt = alt || "Foto do produto";
  i.loading = "lazy";
  i.referrerPolicy = "no-referrer";
  if (classe) i.className = classe;
  return i;
}
function linkExterno(href, classe, rotulo, titulo) {
  const url = urlMercadoLivre(href || "");
  if (!url) return null;
  const a = el("a", classe, rotulo);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  if (titulo) a.title = titulo;
  return a;
}
function nomeDominio(d) { return String(d || "Produto").replace(/^MLB-/, "").replaceAll("_", " "); }

function apiJson(url, opcoes = {}) {
  return fetch(url, { credentials: "same-origin", cache: "no-store", ...opcoes }).then(async r => {
    let dados;
    try { dados = await r.json(); } catch { dados = { erro: "Resposta inesperada do servidor" }; }
    if (!r.ok) {
      const erro = new Error(dados.erro || dados.mensagem || `Erro ${r.status}`);
      erro.status = r.status;
      erro.dados = dados;
      throw erro;
    }
    return dados;
  });
}
function tratarErro(erro, alvo) {
  if (erro.status === 401) {
    autenticarVisual(false);
    $("loginError").textContent = "Sua sessão expirou. Entre novamente.";
    $("loginError").classList.remove("hidden");
    return;
  }
  const msg = erro.dados?.httpMercadoLivre === 403
    ? "A API do Mercado Livre não liberou este dado para a conta conectada."
    : erro.dados?.httpMercadoLivre === 429
      ? "Limite de requisições do Mercado Livre atingido. Tente em instantes."
      : erro.message || "Erro desconhecido";
  if (alvo) {
    alvo.replaceChildren(caixaMensagem("Não foi possível carregar", msg, "!"));
  } else {
    toast(msg);
  }
}
function caixaMensagem(titulo, desc, simbolo = "⌕") {
  const box = el("div", "message");
  box.append(el("span", "message-symbol", simbolo), el("strong", "", titulo), el("p", "", desc));
  return box;
}

// ---------------- navegação ----------------
const TITULOS = {
  descobrir: "Descobrir produtos", radar: "Radar da categoria", comparador: "Comparador",
  concorrencia: "Concorrência", comissoes: "Comissões", diagnostico: "Diagnóstico da API"
};
function mostrarView(nome) {
  for (const v of document.querySelectorAll(".view")) v.classList.toggle("hidden", v.id !== "view-" + nome);
  for (const b of document.querySelectorAll(".nav-btn")) b.classList.toggle("selected", b.dataset.view === nome);
  texto($("crumb"), TITULOS[nome] || "");
  $("sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (nome === "comparador") renderizarBandeja();
  if (nome === "comissoes" && state.autenticado) carregarComissoes();
  if (nome === "radar" && state.classificacao?.categoriaPrincipal && !$("radarInput").value) {
    $("radarInput").value = state.classificacao.categoriaPrincipal;
    carregarRadar(state.classificacao.categoriaPrincipal);
  }
}
function definirModo(modo) {
  state.modo = modo === "vendedor" ? "vendedor" : "afiliado";
  guardar("modo", state.modo);
  for (const b of document.querySelectorAll(".mode-btn")) b.classList.toggle("selected", b.dataset.mode === state.modo);
  texto($("heroText"), state.modo === "vendedor"
    ? "Veja quantos concorrentes vendem o mesmo produto, a faixa de preços, as tarifas do Mercado Livre e sua margem real."
    : "Pesquise, compare ofertas e vendedores, estime sua comissão e descubra o que está vendendo agora na categoria.");
  if (state.produtoAberto) renderizarProduto(state.produtoAberto);
}

// ---------------- autenticação ----------------
function autenticarVisual(autenticado) {
  state.autenticado = autenticado;
  $("loginOverlay").classList.toggle("hidden", autenticado);
  $("logoutButton").classList.toggle("hidden", !autenticado);
  if (!autenticado) {
    state.produtos = [];
    $("productGrid").replaceChildren();
    $("messageBox").classList.remove("hidden");
  }
}

// ---------------- comparador (bandeja) ----------------
function salvarCompare() {
  guardar("compare", state.compare);
  const n = state.compare.length;
  $("navCompareCount").classList.toggle("hidden", n === 0);
  texto($("navCompareCount"), n);
}
function noCompare(id) { return state.compare.some(c => c.id === id); }
function alternarCompare(item) {
  if (noCompare(item.id)) {
    state.compare = state.compare.filter(c => c.id !== item.id);
    toast("Removido do comparador");
  } else {
    if (state.compare.length >= 4) { toast("O comparador aceita até 4 produtos"); return false; }
    state.compare.push({ id: item.id, titulo: item.titulo, imagem: item.imagem, categoria: state.classificacao?.categoriaPrincipal || item.categoria || null });
    toast(`Adicionado ao comparador (${state.compare.length}/4)`);
  }
  salvarCompare();
  return true;
}

// ---------------- DESCOBRIR ----------------
function addCard(item) {
  const card = el("article", "product");
  if (noCompare(item.id)) card.classList.add("in-compare");
  const media = el("div", "product-media");
  media.append(imagem(item.imagem, item.titulo));
  media.append(el("span", "badge badge-cat", nomeDominio(item.dominio)));
  if (item.posicaoRanking) media.append(el("span", "badge badge-rank", `#${item.posicaoRanking} mais vendidos`));
  const cmp = el("button", "compare-toggle" + (noCompare(item.id) ? " on" : ""), "⇄");
  cmp.type = "button";
  cmp.title = "Adicionar ao comparador";
  cmp.addEventListener("click", () => {
    if (alternarCompare(item)) {
      const on = noCompare(item.id);
      cmp.classList.toggle("on", on);
      card.classList.toggle("in-compare", on);
    }
  });
  media.append(cmp);
  card.append(media);

  const body = el("div", "product-body");
  body.append(el("div", "product-domain", item.marca || nomeDominio(item.dominio)));
  body.append(el("h3", "", item.titulo || "Produto sem título"));
  const attrs = Array.isArray(item.atributosPrincipais) ? item.atributosPrincipais.filter(a => a.id !== "BRAND").slice(0, 4) : [];
  if (attrs.length) {
    const box = el("div", "attrs");
    for (const a of attrs) { const c = el("span", "attr", a.valor); c.title = a.nome || ""; box.append(c); }
    body.append(box);
  }
  const motivos = Array.isArray(item.motivos) ? item.motivos.slice(0, 2) : [];
  const alertas = Array.isArray(item.alertas) ? item.alertas.slice(0, 1) : [];
  if (motivos.length || alertas.length) {
    const why = el("ul", "why");
    for (const m of motivos) why.append(el("li", "ok", m));
    for (const m of alertas) why.append(el("li", "warn", m));
    body.append(why);
  }
  const meta = [`ID ${item.id || "—"}`];
  if (item.variantesAgrupadas > 1) meta.push(`${item.variantesAgrupadas} variantes`);
  body.append(el("div", "product-meta", meta.join(" · ")));

  const acoes = el("div", "product-actions");
  const analisar = el("button", "btn-analyze", "Analisar →");
  analisar.type = "button";
  analisar.addEventListener("click", () => abrirProduto(item.id, state.classificacao?.categoriaPrincipal));
  acoes.append(analisar);
  const ofertas = linkExterno(item.linkOferta || item.linkPesquisaOfertas, "btn-soft", item.linkOferta ? "Ver oferta ↗" : "Ofertas ↗", "Abre a busca pública do Mercado Livre");
  if (ofertas) acoes.append(ofertas);
  body.append(acoes);
  card.append(body);
  return card;
}
function ordenar(lista) {
  const modo = $("sortSelect").value;
  const copia = [...lista];
  if (modo === "ranking") copia.sort((a, b) => (a.posicaoRanking ?? 999) - (b.posicaoRanking ?? 999));
  if (modo === "nome") copia.sort((a, b) => String(a.titulo).localeCompare(String(b.titulo), "pt-BR"));
  return copia;
}
function renderizarGrid() {
  const grid = $("productGrid");
  grid.replaceChildren();
  $("messageBox").classList.add("hidden");
  if (!state.produtos.length) {
    grid.append(el("div", "empty-result", "Nenhum produto relevante encontrado. Experimente um refinamento ou um termo mais específico."));
    return;
  }
  const frag = document.createDocumentFragment();
  ordenar(state.produtos).forEach((p, i) => { const c = addCard(p); c.style.animationDelay = `${Math.min(i, 12) * 35}ms`; frag.append(c); });
  grid.append(frag);
}
function esqueleto(n) {
  const grid = $("productGrid");
  grid.replaceChildren();
  for (let i = 0; i < n; i++) grid.append(el("div", "skeleton"));
}
function renderizarRefinamentos(lista) {
  const chips = $("refineChips");
  chips.replaceChildren();
  const itens = Array.isArray(lista) ? lista.slice(0, 10) : [];
  $("refineBar").classList.toggle("hidden", itens.length === 0);
  for (const r of itens) {
    const b = el("button", "chip", r.rotulo);
    b.type = "button";
    b.addEventListener("click", () => { $("searchInput").value = r.consulta; pesquisar(); });
    chips.append(b);
  }
}
function registrarHistorico(q) {
  state.historico = [q, ...state.historico.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  guardar("historico", state.historico);
  renderizarHistorico();
}
function renderizarHistorico() {
  const box = $("historyChips");
  box.replaceChildren();
  $("historyBar").classList.toggle("hidden", state.historico.length === 0);
  for (const q of state.historico) {
    const b = el("button", "", q);
    b.type = "button";
    b.addEventListener("click", () => { $("searchInput").value = q; pesquisar(); });
    box.append(b);
  }
}
async function pesquisar() {
  if (!state.autenticado || state.carregando) return;
  const q = $("searchInput").value.trim();
  const limite = Number($("limitSelect").value);
  if (q.length < 2 || q.length > 100) return;
  state.carregando = true;
  $("searchButton").disabled = true;
  $("searchButton").replaceChildren(el("span", "spin", "◌"), document.createTextNode(" Buscando"));
  for (const id of ["statProducts", "statCatalog", "statRanked", "statApi"]) texto($(id), "—");
  $("refineBar").classList.add("hidden");
  $("searchAllLink").classList.add("hidden");
  $("messageBox").classList.add("hidden");
  texto($("resultsSubtitle"), "Explorando o catálogo, o ranking da categoria e os modelos relacionados…");
  esqueleto(Math.min(limite, 8));
  try {
    const params = new URLSearchParams({ q, limite: String(limite) });
    const dados = await apiJson(`/painel/api/busca?${params}`);
    state.produtos = Array.isArray(dados.produtos) ? dados.produtos : [];
    state.pesquisa = q;
    state.classificacao = dados.classificacao || null;
    guardar("classificacao", state.classificacao);
    registrarHistorico(q);
    texto($("statProducts"), nf.format(state.produtos.length));
    texto($("statCatalog"), dados.totalCatalogo == null ? "—" : nf.format(dados.totalCatalogo));
    texto($("statCategory"), dados.classificacao?.nomeCategoria || "Total informado pela API");
    texto($("statRanked"), nf.format(state.produtos.filter(p => p.posicaoRanking).length));
    const c = dados.consumo || {};
    texto($("statApi"), c.chamadasApi == null ? "—" : nf.format(c.chamadasApi));
    texto($("statApiInfo"), c.respostasDoCache ? `+ ${nf.format(c.respostasDoCache)} do cache` : "Nesta busca");
    texto($("queryEcho"), `· ${q}`);
    const cat = dados.classificacao?.nomeCategoria;
    texto($("resultsSubtitle"), dados.resultadoParcial
      ? "Resultado parcial: limite de requisições do Mercado Livre atingido."
      : `${state.produtos.length} produtos${cat ? ` em ${cat}` : ""} · imagens originais do catálogo`);
    const geral = urlMercadoLivre(dados.linkPesquisaOfertas || "");
    if (geral) { $("searchAllLink").href = geral; $("searchAllLink").classList.remove("hidden"); }
    renderizarRefinamentos(dados.refinamentos);
    renderizarGrid();
  } catch (erro) {
    state.produtos = [];
    $("productGrid").replaceChildren();
    $("messageBox").classList.remove("hidden");
    if (erro.status === 401) tratarErro(erro);
    else $("messageBox").replaceChildren(...caixaMensagem("Não foi possível concluir a pesquisa", erro.message || "Erro desconhecido", "!").childNodes);
  } finally {
    state.carregando = false;
    $("searchButton").disabled = false;
    $("searchButton").replaceChildren(document.createTextNode("Buscar "), el("span", "", "→"));
  }
}

// ---------------- GAVETA DO PRODUTO ----------------
function abrirGaveta() {
  $("drawer").classList.remove("hidden");
  $("drawerBackdrop").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function fecharGaveta() {
  $("drawer").classList.add("hidden");
  $("drawerBackdrop").classList.add("hidden");
  document.body.style.overflow = "";
  state.produtoAberto = null;
}
async function abrirProduto(id, categoria) {
  abrirGaveta();
  const body = $("drawerBody");
  body.replaceChildren(caixaMensagem("Analisando produto…", "Consultando ficha, ofertas, vendedores, tarifas e ranking.", "◌"));
  try {
    const params = new URLSearchParams({ id });
    if (categoria) params.set("categoria", categoria);
    const dados = await apiJson(`/painel/api/produto?${params}`);
    dados._categoria = categoria || null;
    state.produtoAberto = dados;
    renderizarProduto(dados);
  } catch (erro) {
    tratarErro(erro, body);
  }
}
function painel(titulo, info) {
  const p = el("section", "panel");
  const h = el("div", "panel-head");
  h.append(el("h3", "", titulo));
  if (info) h.append(el("small", "", info));
  p.append(h);
  return p;
}
function kpi(rotulo, valor, classe) {
  const k = el("div", "kpi");
  k.append(el("small", "", rotulo), el("strong", classe || "", valor));
  return k;
}
function corNota(n) { return n >= 70 ? "#10b981" : n >= 45 ? "#f59e0b" : "#ef4444"; }

function renderizarProduto(d) {
  const body = $("drawerBody");
  body.replaceChildren();
  const p = d.produto;

  // Cabeçalho com galeria e indicador
  const hero = el("div", "d-hero");
  const gal = el("div");
  const principal = imagem(p.imagens?.[0], p.titulo, "gallery-main");
  gal.append(principal);
  if ((p.imagens || []).length > 1) {
    const th = el("div", "thumbs");
    p.imagens.forEach((src, i) => {
      const b = el("button");
      b.type = "button";
      if (i === 0) b.classList.add("on");
      b.append(imagem(src, `Foto ${i + 1}`));
      b.addEventListener("click", () => {
        if (principal.tagName === "IMG") principal.src = urlImagem(src);
        for (const x of th.children) x.classList.remove("on");
        b.classList.add("on");
      });
      th.append(b);
    });
    gal.append(th);
  }
  hero.append(gal);
  const info = el("div");
  info.append(el("div", "kicker", nomeDominio(p.dominio)));
  info.append(el("h2", "d-title", p.titulo || "Produto"));
  const badges = el("div", "d-badges");
  badges.append(el("span", "", `ID ${p.id}`));
  if (d.ranking?.posicao) badges.append(el("span", "g", `#${d.ranking.posicao} mais vendidos`));
  if (d.ofertas?.disponivel) badges.append(el("span", "", `${d.ofertas.resumo.vendedoresDistintos} vendedores`));
  info.append(badges);
  const ind = d.indicador;
  const score = el("div", "score");
  const ring = el("div", "ring");
  ring.style.setProperty("--p", String(ind?.nota ?? 0));
  ring.style.setProperty("--ring-color", corNota(ind?.nota ?? 0));
  ring.append(el("b", "", ind?.nota ?? "—"));
  score.append(ring);
  const st = el("div");
  st.append(el("strong", "", "Indicador AnPrice"));
  st.append(el("br"));
  st.append(el("small", "", ind?.nota == null
    ? `Dados insuficientes (${ind?.confiabilidade ?? 0}% disponíveis) · cadastre a comissão ou veja o diagnóstico`
    : `Calculado · confiabilidade ${ind.confiabilidade}% dos dados`));
  score.append(st);
  info.append(score);
  const links = el("div", "d-links");
  const lp = linkExterno(d.links?.pesquisaPublica, "ghost-link", "Pesquisar ofertas ↗");
  if (lp) links.append(lp);
  const cmp = el("button", "ghost-button", noCompare(p.id) ? "✓ No comparador" : "⇄ Comparar");
  cmp.type = "button";
  cmp.addEventListener("click", () => {
    if (alternarCompare({ id: p.id, titulo: p.titulo, imagem: p.imagens?.[0], categoria: d._categoria })) {
      cmp.textContent = noCompare(p.id) ? "✓ No comparador" : "⇄ Comparar";
      renderizarGrid();
    }
  });
  links.append(cmp);
  info.append(links);
  hero.append(info);
  body.append(hero);

  // Indicador detalhado
  const pi = painel("Como o indicador foi calculado", "estimativa, não garantia");
  const bars = el("div", "comp-bars");
  for (const c of ind?.componentes || []) {
    const row = el("div", "bar-row");
    row.append(el("span", "", c.nome));
    const track = el("div", "track");
    const fill = el("div", "fill");
    track.append(fill);
    row.append(track);
    row.append(el("span", c.pontos === null ? "na" : "", c.pontos === null ? "s/ dado" : `${c.pontos}/${c.max}`));
    row.append(el("p", "", c.explicacao));
    bars.append(row);
    requestAnimationFrame(() => { fill.style.width = c.pontos === null ? "0%" : `${(c.pontos / c.max) * 100}%`; });
  }
  pi.append(bars);

  const blocos = [];

  // Preços e ofertas
  const po = painel("Preços e concorrência", d.ofertas?.disponivel ? "ofertas ativas no catálogo" : "");
  if (d.ofertas?.disponivel && d.ofertas.ofertas.length) {
    const r = d.ofertas.resumo;
    const k = el("div", "kpis");
    k.append(kpi("Menor preço", dinheiro(r.precoMinimo)), kpi("Mediana", dinheiro(r.precoMediano)), kpi("Maior preço", dinheiro(r.precoMaximo)), kpi("Frete grátis", r.percentualFreteGratis == null ? "—" : `${r.percentualFreteGratis}%`));
    po.append(k);
    if (r.precoMinimo && r.precoMaximo && r.precoMaximo > r.precoMinimo) {
      const range = el("div", "price-range");
      const marc = el("i");
      marc.style.left = `${((r.precoMediano - r.precoMinimo) / (r.precoMaximo - r.precoMinimo)) * 100}%`;
      marc.title = "Mediana";
      range.append(marc);
      po.append(range);
      const leg = el("div", "range-legend");
      leg.append(el("span", "", "mais barato"), el("span", "", `variação de ${r.variacaoPercentual}%`), el("span", "", "mais caro"));
      po.append(leg);
    }
    const t = el("table", "otable");
    const th = el("thead"); const trh = el("tr");
    for (const h of ["Vendedor", "Preço", "Frete", "Tipo", "Anúncio"]) trh.append(el("th", "", h));
    th.append(trh); t.append(th);
    const tb = el("tbody");
    for (const o of d.ofertas.ofertas.slice(0, 12)) {
      const tr = el("tr");
      const v = el("td");
      const nivel = String(o.vendedor?.nivelReputacao || "")[0];
      v.append(el("span", "rep" + (nivel ? " l" + nivel : "")));
      v.append(document.createTextNode(o.vendedor?.apelido || `Vendedor ${o.vendedorId ?? "—"}`));
      if (o.vendedor?.mercadoLider) v.append(el("small", "", ` · ${o.vendedor.mercadoLider}`));
      if (o.lojaOficial) v.append(el("small", "", " · loja oficial"));
      tr.append(v);
      const preco = el("td");
      preco.append(el("b", "", dinheiro(o.preco)));
      if (o.precoOriginal && o.precoOriginal > o.preco) preco.append(el("small", "", ` −${Math.round((1 - o.preco / o.precoOriginal) * 100)}%`));
      tr.append(preco);
      tr.append(el("td", "", o.freteGratis ? (o.logistica === "fulfillment" ? "Grátis · Full" : "Grátis") : "Pago"));
      tr.append(el("td", "", o.tipoAnuncio === "gold_pro" ? "Premium" : o.tipoAnuncio === "gold_special" ? "Clássico" : (o.tipoAnuncio || "—")));
      tr.append(el("td", "", o.anuncioId || "—"));
      tb.append(tr);
    }
    t.append(tb);
    po.append(t);
  } else {
    po.append(el("div", "unavail", d.ofertas?.motivo || "Nenhuma oferta ativa encontrada para este produto."));
    if (d.produto.vencedorCatalogo?.preco) {
      const k = el("div", "kpis");
      k.append(kpi("Vencedor do catálogo", dinheiro(d.produto.vencedorCatalogo.preco)));
      po.append(k);
    }
  }

  // Afiliado
  const pa = painel("Calculadora de afiliado", "taxa informada por você");
  const ref = d.precoReferencia?.valor ?? null;
  const ca = el("div", "calc");
  const lPreco = el("label", "", "Preço de venda (R$)");
  const iPreco = el("input"); iPreco.type = "number"; iPreco.step = "0.01"; iPreco.min = "0"; iPreco.value = ref ?? "";
  lPreco.append(iPreco);
  const lTaxa = el("label", "", "Comissão do afiliado (%)");
  const iTaxa = el("input"); iTaxa.type = "number"; iTaxa.step = "0.1"; iTaxa.min = "0"; iTaxa.max = "50"; iTaxa.value = d.afiliado?.taxa?.percentual ?? "";
  iTaxa.placeholder = "Veja no seu painel de afiliado";
  lTaxa.append(iTaxa);
  const outA = el("div", "calc-out");
  const kCom = kpi("Comissão por venda", "—", "pos");
  const k10 = kpi("Em 10 vendas", "—");
  const k100 = kpi("Em 100 vendas", "—");
  outA.append(kCom, k10, k100);
  const recalcA = () => {
    const pr = Number(iPreco.value), tx = Number(iTaxa.value);
    const ok = pr > 0 && iTaxa.value !== "" && tx >= 0;
    const v = ok ? pr * tx / 100 : null;
    kCom.lastChild.textContent = v === null ? "—" : dinheiro(v);
    k10.lastChild.textContent = v === null ? "—" : dinheiro(v * 10);
    k100.lastChild.textContent = v === null ? "—" : dinheiro(v * 100);
  };
  iPreco.addEventListener("input", recalcA); iTaxa.addEventListener("input", recalcA);
  ca.append(lPreco, lTaxa, outA);
  pa.append(ca);
  const salvar = el("button", "ghost-button", `Salvar taxa para ${nomeDominio(p.dominio)}`);
  salvar.type = "button";
  salvar.addEventListener("click", async () => {
    if (iTaxa.value === "" || !p.dominio) return toast("Informe a taxa primeiro");
    try {
      await apiJson("/painel/api/comissoes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chave: p.dominio, percentual: Number(iTaxa.value), rotulo: nomeDominio(p.dominio) }) });
      toast("Taxa salva. Ela será usada nas próximas análises.");
    } catch (e) { tratarErro(e); }
  });
  const rodape = el("p", "hint", d.afiliado?.observacao || "");
  pa.append(rodape, salvar);
  recalcA();

  // Vendedor
  const pv = painel("Calculadora de margem do vendedor", d.tarifas?.disponivel ? "tarifas oficiais da API" : "");
  if (d.tarifas?.disponivel) {
    const cv = el("div", "calc");
    const lTipo = el("label", "", "Tipo de anúncio");
    const sTipo = el("select");
    for (const t of d.tarifas.tipos) {
      const o = el("option", "", `${t.nome} · ${t.percentual != null ? t.percentual + "%" : dinheiro(t.tarifaVenda)}`);
      o.value = t.tipo; sTipo.append(o);
    }
    lTipo.append(sTipo);
    const lPv = el("label", "", "Seu preço de venda (R$)");
    const iPv = el("input"); iPv.type = "number"; iPv.step = "0.01"; iPv.value = d.tarifas.precoReferencia ?? "";
    lPv.append(iPv);
    const lCusto = el("label", "", "Custo do produto (R$)");
    const iCusto = el("input"); iCusto.type = "number"; iCusto.step = "0.01"; iCusto.min = "0"; iCusto.placeholder = "Quanto você paga";
    lCusto.append(iCusto);
    const lFrete = el("label", "", "Frete/outros custos (R$)");
    const iFrete = el("input"); iFrete.type = "number"; iFrete.step = "0.01"; iFrete.min = "0"; iFrete.value = "0";
    lFrete.append(iFrete);
    const outV = el("div", "calc-out");
    const kTar = kpi("Tarifa Mercado Livre", "—");
    const kLuc = kpi("Lucro por venda", "—");
    const kMar = kpi("Margem", "—");
    outV.append(kTar, kLuc, kMar);
    const recalcV = () => {
      const t = d.tarifas.tipos.find(x => x.tipo === sTipo.value);
      const preco = Number(iPv.value);
      let tarifa = null;
      if (t && preco > 0) {
        tarifa = t.percentual != null ? preco * t.percentual / 100 + (t.taxaFixa || 0) : t.tarifaVenda;
      }
      kTar.lastChild.textContent = tarifa === null ? "—" : dinheiro(tarifa);
      if (tarifa === null || iCusto.value === "") { kLuc.lastChild.textContent = "—"; kMar.lastChild.textContent = "—"; return; }
      const lucro = preco - tarifa - Number(iCusto.value) - Number(iFrete.value || 0);
      kLuc.lastChild.textContent = dinheiro(lucro);
      kLuc.lastChild.className = lucro >= 0 ? "pos" : "neg";
      kMar.lastChild.textContent = `${((lucro / preco) * 100).toFixed(1)}%`;
      kMar.lastChild.className = lucro >= 0 ? "pos" : "neg";
    };
    for (const i of [sTipo, iPv, iCusto, iFrete]) i.addEventListener("input", recalcV);
    cv.append(lTipo, lPv, lCusto, lFrete, outV);
    pv.append(cv);
    pv.append(el("p", "hint", "Tarifa recalculada pelo percentual oficial da categoria. Impostos e frete do vendedor dependem do seu caso; inclua-os em “outros custos”."));
    recalcV();
  } else {
    pv.append(el("div", "unavail", d.tarifas?.motivo || "Tarifas indisponíveis. Pesquise o produto em “Descobrir” para identificar a categoria."));
  }

  // Ficha técnica
  const pf = painel("Ficha técnica", `${(p.atributos || []).length} atributos`);
  if (p.caracteristicas?.length) {
    const ul = el("ul", "why");
    for (const c of p.caracteristicas) ul.append(el("li", "ok", c));
    pf.append(ul);
  }
  const spec = el("div", "spec");
  for (const a of (p.atributos || []).slice(0, 40)) {
    const row = el("div");
    row.append(el("span", "", a.nome), el("b", "", a.valor));
    spec.append(row);
  }
  pf.append(spec);

  if (state.modo === "vendedor") blocos.push(po, pv, pi, pa, pf);
  else blocos.push(pi, pa, po, pv, pf);
  body.append(...blocos);
}

// ---------------- COMPARADOR ----------------
function renderizarBandeja() {
  const tray = $("compareTray");
  tray.replaceChildren();
  for (let i = 0; i < 4; i++) {
    const c = state.compare[i];
    const slot = el("div", "tray-slot" + (c ? " filled" : ""));
    if (c) {
      slot.append(imagem(c.imagem, c.titulo), el("span", "", c.titulo || c.id));
      const x = el("button", "", "✕"); x.type = "button"; x.title = "Remover";
      x.addEventListener("click", () => { state.compare.splice(i, 1); salvarCompare(); renderizarBandeja(); });
      slot.append(x);
    } else {
      slot.append(document.createTextNode("Vazio · use ⇄ nos cards"));
    }
    tray.append(slot);
  }
  $("compareRun").disabled = state.compare.length < 2;
}
async function comparar() {
  if (state.compare.length < 2) return toast("Adicione pelo menos 2 produtos");
  const res = $("compareResult");
  res.replaceChildren(caixaMensagem("Comparando…", "Consultando ofertas, tarifas e ficha técnica de cada produto.", "◌"));
  try {
    const categoria = state.compare.find(c => c.categoria)?.categoria;
    const params = new URLSearchParams({ ids: state.compare.map(c => c.id).join(",") });
    if (categoria) params.set("categoria", categoria);
    const d = await apiJson(`/painel/api/comparar?${params}`);
    renderizarComparacao(d);
  } catch (e) { tratarErro(e, res); }
}
function renderizarComparacao(d) {
  const res = $("compareResult");
  res.replaceChildren();
  const prods = d.produtos;
  const t = el("table", "ctable");
  const thead = el("thead"); const hr = el("tr");
  hr.append(el("th", "", ""));
  for (const p of prods) {
    const th = el("th");
    const hc = el("div", "head-card");
    if (p.erro) { hc.append(el("strong", "", `${p.id}: ${p.erro.motivo}`)); }
    else {
      hc.append(imagem(p.imagem, p.titulo), el("strong", "", p.titulo));
      const b = el("button", "btn-soft", "Analisar"); b.type = "button";
      b.addEventListener("click", () => abrirProduto(p.id, state.compare.find(c => c.id === p.id)?.categoria));
      hc.append(b);
    }
    th.append(hc); hr.append(th);
  }
  thead.append(hr); t.append(thead);
  const tb = el("tbody");
  const grupo = nome => { const tr = el("tr", "group"); const th = el("th", "", nome); th.colSpan = prods.length + 1; tr.append(th); tb.append(tr); };
  const linha = (nome, valores, melhor) => {
    const tr = el("tr"); tr.append(el("th", "", nome));
    const nums = valores.map(v => (typeof v?.n === "number" ? v.n : null));
    const validos = nums.filter(n => n !== null);
    const alvo = melhor && validos.length > 1 ? (melhor === "min" ? Math.min(...validos) : Math.max(...validos)) : null;
    valores.forEach((v, i) => tr.append(el("td", alvo !== null && nums[i] === alvo ? "best" : "", v?.t ?? "—")));
    tb.append(tr);
  };
  const ok = p => !p.erro;
  grupo("Oportunidade");
  linha("Indicador AnPrice", prods.map(p => ok(p) && p.indicador?.nota != null ? { n: p.indicador.nota, t: `${p.indicador.nota} / 100` } : null), "max");
  linha("Posição no ranking", prods.map(p => ok(p) && p.posicaoRanking ? { n: p.posicaoRanking, t: `#${p.posicaoRanking}` } : { t: "fora do top" }), "min");
  linha("Comissão estimada", prods.map(p => ok(p) && p.afiliado?.comissaoEstimada != null ? { n: p.afiliado.comissaoEstimada, t: dinheiro(p.afiliado.comissaoEstimada) } : { t: "cadastre a taxa" }), "max");
  grupo("Preço e concorrência");
  linha("Preço de referência", prods.map(p => ok(p) && p.precoReferencia ? { n: p.precoReferencia.valor, t: dinheiro(p.precoReferencia.valor) } : null), "min");
  linha("Faixa de preços", prods.map(p => ok(p) && p.ofertas ? { t: `${dinheiro(p.ofertas.precoMinimo)} – ${dinheiro(p.ofertas.precoMaximo)}` } : { t: p.motivoOfertas ? "não liberado" : "—" }));
  linha("Vendedores", prods.map(p => ok(p) && p.ofertas ? { n: p.ofertas.vendedoresDistintos, t: String(p.ofertas.vendedoresDistintos) } : null), "min");
  linha("Frete grátis", prods.map(p => ok(p) && p.ofertas?.percentualFreteGratis != null ? { n: p.ofertas.percentualFreteGratis, t: `${p.ofertas.percentualFreteGratis}%` } : null), "max");
  linha("Tarifa Clássico", prods.map(p => { const t = ok(p) && p.tarifas?.tipos?.find(x => x.tipo === "gold_special"); return t ? { n: t.tarifaVenda, t: `${dinheiro(t.tarifaVenda)}${t.percentual != null ? ` (${t.percentual}%)` : ""}` } : null; }), "min");
  linha("Tarifa Premium", prods.map(p => { const t = ok(p) && p.tarifas?.tipos?.find(x => x.tipo === "gold_pro"); return t ? { n: t.tarifaVenda, t: `${dinheiro(t.tarifaVenda)}${t.percentual != null ? ` (${t.percentual}%)` : ""}` } : null; }), "min");
  if (d.atributos?.length) {
    grupo("Ficha técnica (diferenças primeiro)");
    for (const a of d.atributos) {
      const tr = el("tr", a.diferente ? "diff" : "");
      tr.append(el("th", "", a.nome));
      for (const v of a.valores) tr.append(el("td", "", v ?? "—"));
      tb.append(tr);
    }
  }
  t.append(tb);
  res.append(t);
}

// ---------------- RADAR ----------------
async function carregarRadar(categoria) {
  if (!/^MLB\d{1,12}$/.test(categoria || "")) return toast("Informe uma categoria como MLB1055");
  const rank = $("radarRank"), trends = $("radarTrends");
  rank.replaceChildren(caixaMensagem("Carregando radar…", "Consultando mais vendidos e tendências.", "◌"));
  trends.replaceChildren();
  try {
    const d = await apiJson(`/painel/api/radar?categoria=${encodeURIComponent(categoria)}`);
    const path = $("radarPath"); path.replaceChildren();
    d.categoria.caminho.forEach((c, i) => {
      if (i) path.append(el("span", "", "›"));
      const b = el("button", "", c.nome); b.type = "button";
      b.addEventListener("click", () => { $("radarInput").value = c.id; carregarRadar(c.id); });
      path.append(b);
    });
    const subs = $("radarSubs"); subs.replaceChildren();
    for (const s of d.categoria.subcategorias) {
      const b = el("button", "chip", s.nome); b.type = "button";
      b.addEventListener("click", () => { $("radarInput").value = s.id; carregarRadar(s.id); });
      subs.append(b);
    }
    rank.replaceChildren();
    if (d.maisVendidos.disponivel) {
      texto($("radarRankInfo"), `${d.maisVendidos.itens.length} posições · ${d.categoria.nome || categoria}`);
      for (const it of d.maisVendidos.itens) {
        const row = el("div", "rank-item");
        row.append(el("div", "rank-pos", it.posicao ?? "—"));
        row.append(imagem(it.imagem, it.titulo, "rank-img"));
        const inf = el("div", "rank-info");
        inf.append(el("strong", "", it.titulo || (it.tipo === "USER_PRODUCT" ? "Anúncio de terceiro" : it.id)));
        inf.append(el("small", "", it.detalhesDisponiveis ? `${nomeDominio(it.dominio)}${it.precoVencedor ? " · " + dinheiro(it.precoVencedor) : ""}` : (it.observacao || "Detalhes indisponíveis")));
        row.append(inf);
        if (it.detalhesDisponiveis) {
          const b = el("button", "btn-soft", "Analisar"); b.type = "button";
          b.addEventListener("click", () => abrirProduto(it.id, categoria));
          row.append(b);
        }
        rank.append(row);
      }
    } else {
      rank.append(el("div", "unavail", d.maisVendidos.motivo));
    }
    if (d.tendencias.disponivel && d.tendencias.termos.length) {
      d.tendencias.termos.forEach((t, i) => {
        const b = el("button", `trend t${(i % 4) + 1}${i > 9 ? " small" : ""}`, t.termo); b.type = "button";
        b.addEventListener("click", () => { mostrarView("descobrir"); $("searchInput").value = t.termo; pesquisar(); });
        trends.append(b);
      });
    } else {
      trends.append(el("div", "unavail", d.tendencias.motivo || "Sem tendências para esta categoria."));
    }
  } catch (e) { tratarErro(e, rank); }
}

// ---------------- CONCORRÊNCIA ----------------
const STATUS = {
  winning: ["Ganhando", "win"], competing: ["Perdendo", "lose"],
  sharing_first_place: ["Empatado em 1º", "share"], listed: ["Fora da disputa", "neutral"]
};
async function carregarConcorrencia() {
  const lista = $("compList");
  lista.replaceChildren(caixaMensagem("Carregando seus anúncios…", "Consultando a disputa de cada anúncio de catálogo.", "◌"));
  try {
    const d = await apiJson("/painel/api/concorrencia");
    const sum = $("compSummary");
    sum.replaceChildren();
    sum.classList.remove("hidden");
    const card = (c, rot, val, sub) => { const s = el("div", "stat " + c); const h = el("div", "stat-head", rot); s.append(h, el("strong", "", val), el("small", "", sub)); return s; };
    sum.append(
      card("s1", "ANÚNCIOS", nf.format(d.resumo.total), d.conta?.apelido ? `Conta ${d.conta.apelido}` : "Conta conectada"),
      card("s3", "GANHANDO", nf.format(d.resumo.ganhando), "Vencedor do catálogo"),
      card("s4", "PERDENDO", nf.format(d.resumo.perdendo), "Há concorrente melhor"),
      card("s2", "EMPATADOS / OUTROS", nf.format(d.resumo.compartilhando + d.resumo.outros), d.somenteCatalogo ? "Anúncios de catálogo" : "Inclui anúncios fora do catálogo")
    );
    lista.replaceChildren();
    if (!d.itens.length) { lista.append(caixaMensagem("Nenhum anúncio ativo encontrado", "A conta conectada não tem anúncios ativos.", "∅")); return; }
    for (const it of d.itens) {
      const row = el("div", "comp-item");
      row.append(imagem(it.imagem, it.titulo));
      const mid = el("div");
      mid.append(el("h4", "", it.titulo || it.anuncioId));
      const tags = el("div", "comp-tags");
      const c = it.competicao || {};
      const [rot, cls] = STATUS[c.status] || [c.disponivel === false ? "Sem disputa" : (c.status || "—"), "neutral"];
      const pill = el("span", "pill " + cls, rot);
      tags.append(pill);
      tags.append(el("span", "", it.anuncioId));
      if (it.vendidos != null) tags.append(el("span", "", `${nf.format(it.vendidos)} vendidos`));
      if (it.estoque != null) tags.append(el("span", "", `estoque ${nf.format(it.estoque)}`));
      for (const o of (c.oportunidades || []).slice(0, 3)) tags.append(el("span", "", `💡 ${o}`));
      mid.append(tags);
      if (c.disponivel === false) mid.append(el("p", "hint", c.motivo));
      if (c.vencedor && c.status !== "winning") mid.append(el("p", "hint", `Vencedor: ${c.vencedor.anuncioId || "—"} por ${dinheiro(c.vencedor.preco)}${c.vencedor.vantagens?.length ? " · " + c.vencedor.vantagens.join(", ") : ""}`));
      row.append(mid);
      const pr = el("div", "comp-price");
      pr.append(el("small", "", "Seu preço"), el("strong", "", dinheiro(c.precoAtual ?? it.preco)));
      if (c.precoParaGanhar != null) {
        pr.append(el("small", "", `Para ganhar: ${dinheiro(c.precoParaGanhar)}`));
        if (c.diferenca > 0) pr.append(el("small", "", `Reduzir ${dinheiro(c.diferenca)}`));
      }
      if (it.produtoCatalogo) {
        const b = el("button", "btn-soft", "Ver concorrentes"); b.type = "button";
        b.addEventListener("click", () => abrirProduto(it.produtoCatalogo, it.categoria));
        pr.append(b);
      }
      row.append(pr);
      lista.append(row);
    }
  } catch (e) { tratarErro(e, lista); }
}

// ---------------- COMISSÕES ----------------
async function carregarComissoes() {
  const box = $("commList");
  box.replaceChildren(el("p", "muted", "Carregando…"));
  try {
    const d = await apiJson("/painel/api/comissoes");
    box.replaceChildren();
    if (!d.comissoes.length) { box.append(el("div", "unavail", "Nenhuma taxa cadastrada ainda. Comece com PADRAO para aplicar a todas as categorias.")); return; }
    for (const c of d.comissoes.sort((a, b) => String(a.chave).localeCompare(b.chave))) {
      const row = el("div", "comm-row");
      row.append(el("strong", "", `${c.percentual}%`));
      const inf = el("div");
      inf.append(document.createTextNode(c.chave === "PADRAO" ? "Padrão (todas as categorias)" : c.chave));
      inf.append(el("small", "", `${c.rotulo || ""}${c.atualizadoEm ? " · atualizado " + new Date(c.atualizadoEm).toLocaleDateString("pt-BR") : ""}`));
      row.append(inf);
      const rm = el("button", "ghost-button", "Remover"); rm.type = "button";
      rm.addEventListener("click", async () => {
        try {
          await apiJson("/painel/api/comissoes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chave: c.chave, remover: true }) });
          carregarComissoes();
        } catch (e) { tratarErro(e); }
      });
      row.append(rm);
      box.append(row);
    }
  } catch (e) { tratarErro(e, box); }
}

// ---------------- DIAGNÓSTICO ----------------
async function diagnosticar() {
  const box = $("diagList");
  box.replaceChildren(caixaMensagem("Testando recursos…", "Uma chamada por recurso.", "◌"));
  try {
    const d = await apiJson("/painel/api/recursos");
    box.replaceChildren();
    for (const r of d.recursos) {
      const row = el("div", "diag-row");
      row.append(el("span", "pill " + (r.disponivel ? "win" : "lose"), r.disponivel ? "Liberado" : `Bloqueado ${r.httpMercadoLivre || ""}`));
      row.append(el("b", "", r.recurso), el("code", "", r.caminho));
      box.append(row);
    }
  } catch (e) { tratarErro(e, box); }
}

// ---------------- eventos ----------------
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginButton").disabled = true;
  $("loginError").classList.add("hidden");
  try {
    await apiJson("/painel/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario: $("loginUser").value, senha: $("loginPassword").value }) });
    $("loginPassword").value = ""; $("loginUser").value = "";
    autenticarVisual(true);
    await pesquisar();
  } catch (erro) {
    $("loginPassword").value = "";
    $("loginError").textContent = erro.message;
    $("loginError").classList.remove("hidden");
  } finally { $("loginButton").disabled = false; }
});
$("logoutButton").addEventListener("click", async () => {
  try { await apiJson("/painel/api/logout", { method: "POST" }); } catch { /* sessão já expirada */ }
  autenticarVisual(false);
});
$("searchForm").addEventListener("submit", e => { e.preventDefault(); pesquisar(); });
$("sortSelect").addEventListener("change", () => { if (state.produtos.length) renderizarGrid(); });
for (const b of document.querySelectorAll("[data-search]")) {
  b.addEventListener("click", () => { $("searchInput").value = b.dataset.search; pesquisar(); });
}
for (const b of document.querySelectorAll(".nav-btn")) b.addEventListener("click", () => mostrarView(b.dataset.view));
for (const b of document.querySelectorAll(".mode-btn")) b.addEventListener("click", () => definirModo(b.dataset.mode));
$("menuButton").addEventListener("click", () => $("sidebar").classList.toggle("open"));
$("drawerClose").addEventListener("click", fecharGaveta);
$("drawerBackdrop").addEventListener("click", fecharGaveta);
document.addEventListener("keydown", e => { if (e.key === "Escape") fecharGaveta(); });
$("compareRun").addEventListener("click", comparar);
$("compareClear").addEventListener("click", () => { state.compare = []; salvarCompare(); renderizarBandeja(); $("compareResult").replaceChildren(); if (state.produtos.length) renderizarGrid(); });
$("radarForm").addEventListener("submit", e => { e.preventDefault(); carregarRadar($("radarInput").value.trim()); });
$("compRun").addEventListener("click", carregarConcorrencia);
$("diagRun").addEventListener("click", diagnosticar);
$("commForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await apiJson("/painel/api/comissoes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chave: $("commKey").value.trim().toUpperCase(), percentual: Number($("commPct").value), rotulo: $("commLabel").value.trim() }) });
    $("commForm").reset();
    toast("Taxa salva");
    carregarComissoes();
  } catch (erro) { tratarErro(erro); }
});

// ---------------- início ----------------
state.compare = ler("compare", []).filter(c => c && /^MLB\d+$/.test(c.id)).slice(0, 4);
state.historico = ler("historico", []).filter(x => typeof x === "string").slice(0, 8);
state.classificacao = ler("classificacao", null);
salvarCompare();
renderizarHistorico();
definirModo(ler("modo", "afiliado"));
(async () => {
  try {
    const dados = await apiJson("/painel/api/sessao");
    autenticarVisual(Boolean(dados.autenticado));
    if (dados.autenticado) await pesquisar();
  } catch { autenticarVisual(false); }
})();
