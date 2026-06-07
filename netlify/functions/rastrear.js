/**
 * Netlify Function — Proxy SSW + Onfleet
 *
 * Modos:
 *   ?carrier=AUTO   → tenta FITLOG → MIRA → ONFLEET (padrão)
 *   ?carrier=FITLOG → força Fitlog (usa &nf=)
 *   ?carrier=MIRA   → força Mira   (usa &nf=)
 *   ?carrier=ONFLEET→ força Onfleet (usa &pedido=)
 *
 * Detecção inteligente no AUTO:
 *   - Input numérico puro → tenta FITLOG → MIRA → (se falhar) ONFLEET
 *   - Input com "SAL-ORD-" ou não-numérico → pula direto para ONFLEET
 */

const CNPJ        = process.env.CNPJ         || "42418313000104";
const SENHA_FITLOG = process.env.SENHA_FITLOG || "0104";
const SENHA_MIRA   = process.env.SENHA_MIRA   || "";
// ONFLEET_API_KEY é lida em runtime (process.env) dentro das funções,
// porque constantes de topo podem ser avaliadas antes do Netlify injetar as env vars.

const URL_RESULT    = "https://ssw.inf.br/2/resultSSW";
const URL_DETALHADO = "https://ssw.inf.br/2/SSWDetalhado";
const ONFLEET_BASE  = "https://onfleet.com/api/v2";

// Teams brasileiros — a busca de pedidos é restrita a estes (ignora México).
// IDs obtidos via GET /teams.
const ONFLEET_TEAMS_BR = [
  "~3FasWs57JwmvFAp~z1UKLAb", // Brasil
  "NzJc8N3SAWdW8sK2MP7BUeiA", // Inhouse_BR_CPN
];

const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
  "Origin": "https://ssw.inf.br",
  "Referer": "https://ssw.inf.br/2/rastreamento?"
};

// States Onfleet (campo numérico `state`):
//   0 = Unassigned  (criada, sem motorista)
//   1 = Assigned    (atribuída a um motorista)
//   2 = Active      (em rota / in transit — rastreamento ao vivo)
//   3 = Completed   (finalizada — sucesso OU falha; ver completionDetails.success)
const ONFLEET_STATE_MAP = {
  0: { label: "Pedido recebido",     cor: "warning" },
  1: { label: "Aguardando saída",    cor: "warning" },
  2: { label: "Em rota de entrega",  cor: "info"    },
  3: { label: "Entregue",            cor: "success" },  // refinado por completionDetails
};

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  try {
    const params        = event.queryStringParameters || {};
    const carrierParam  = (params.carrier || "AUTO").toUpperCase();
    // Aceita tanto &nf= (SSW) quanto &pedido= (Onfleet)
    const inputBruto    = (params.nf || params.pedido || "").trim();

    // DEBUG: ?debugtask=1 → mostra os campos de container/team de uma task real
    if (params.debugtask === "1") {
      const from = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const r = await fetch(`${ONFLEET_BASE}/tasks/all?from=${from}&state=0,1,2,3`, { headers: { Authorization: onfleetAuth() } });
      const data = await r.json();
      const tasks = Array.isArray(data) ? data : (data.tasks || []);
      // Pega as 3 primeiras e mostra campos relacionados a team
      const amostra = tasks.slice(0, 3).map(t => ({
        id: t.id,
        container: t.container,
        worker: t.worker,
        metadata: t.metadata,
        notesPreview: (t.notes || "").slice(0, 60),
      }));
      return resp(200, corsHeaders, { ok: true, totalNaPagina: tasks.length, amostra });
    }

    // DEBUG: ?debugteams=1 → lista os teams (id + nome)
    if (params.debugteams === "1") {
      const r = await fetch(`${ONFLEET_BASE}/teams`, { headers: { Authorization: onfleetAuth() } });
      const teams = await r.json();
      return resp(200, corsHeaders, {
        ok: true,
        teams: (Array.isArray(teams) ? teams : []).map(t => ({ id: t.id, name: t.name })),
      });
    }

    // DEBUG: ?debugfind=SAL-ORD-xxx → rastreia o pedido em todas as páginas
    if (params.debugfind) {
      const dbg = await debugFindPedido(params.debugfind);
      return resp(200, corsHeaders, dbg);
    }

    if (!inputBruto) {
      return resp(400, corsHeaders, { ok: false, erro: "Informe o número da NF ou do pedido" });
    }

    // ─── Modo AUTO ──────────────────────────────────────────────────────────
    if (carrierParam === "AUTO") {
      const ehNumerico = /^\d+$/.test(inputBruto);

      if (!ehNumerico) {
        // Formato SAL-ORD-... ou qualquer não-numérico → vai direto pra Onfleet
        const r = await consultarOnfleet(inputBruto);
        return resp(200, corsHeaders, r);
      }

      // Numérico → tenta SSW (Fitlog → Mira) e só depois Onfleet
      const nf = inputBruto.replace(/\D/g, "");
      const ordemSSW = ["FITLOG", "MIRA"];

      for (const carrier of ordemSSW) {
        try {
          const r = await consultarCarrier(carrier, nf);
          if (r && r.ok) return resp(200, corsHeaders, r);
        } catch (_) { /* continua */ }
      }

      // Última tentativa: Onfleet com o número puro (raro, mas possível)
      const rOnfleet = await consultarOnfleet(nf);
      if (rOnfleet && rOnfleet.ok) return resp(200, corsHeaders, rOnfleet);

      return resp(200, corsHeaders, {
        ok: false,
        erro: "Pedido não encontrado em nenhuma transportadora",
        nf: inputBruto,
        carrier: "AUTO"
      });
    }

    // ─── Modo explícito ──────────────────────────────────────────────────────
    if (carrierParam === "ONFLEET") {
      const r = await consultarOnfleet(inputBruto);
      return resp(200, corsHeaders, r);
    }

    if (!["FITLOG", "MIRA"].includes(carrierParam)) {
      return resp(400, corsHeaders, { ok: false, erro: "Transportadora inválida" });
    }

    const nf = inputBruto.replace(/\D/g, "");
    const resultado = await consultarCarrier(carrierParam, nf);
    return resp(200, corsHeaders, resultado);

  } catch (err) {
    return resp(500, corsHeaders, { ok: false, erro: "Exceção: " + err.message });
  }
};

// ═══════════════════════════════════════════════════════════════
//  ONFLEET
// ═══════════════════════════════════════════════════════════════

function onfleetAuth() {
  const key = process.env.ONFLEET_API_KEY || "";
  return "Basic " + Buffer.from(key + ":").toString("base64");
}

async function consultarOnfleet(pedidoRaw) {
  if (!process.env.ONFLEET_API_KEY) {
    return { ok: false, erro: "ONFLEET_API_KEY não configurada.", pedido: pedidoRaw, carrier: "ONFLEET" };
  }

  // Chave de busca = primeiro bloco hex após SAL-ORD- (parte única do pedido)
  const chave = extrairChavePedido(pedidoRaw);

  const task = await buscarTaskOnfleet(chave);

  if (!task) {
    return { ok: false, erro: "Pedido não encontrado na Onfleet", pedido: pedidoRaw, nf: pedidoRaw, carrier: "ONFLEET" };
  }

  const stateInfo = ONFLEET_STATE_MAP[task.state] || { label: "Status desconhecido", cor: "" };

  // Quando a task está completada (state 3), refina entre Entregue e Falha
  // usando completionDetails.success (true = sucesso, false = falha)
  let statusLabel = stateInfo.label;
  let statusCor   = stateInfo.cor;
  if (task.state === 3) {
    if (task.completionDetails?.success === false) {
      statusLabel = "Entrega não concluída";
      statusCor   = "danger";
    } else {
      statusLabel = "Entregue";
      statusCor   = "success";
    }
  }

  // Endereço de destino
  const dest = task.destination?.address || {};
  const enderecoParts = [
    dest.street && dest.number ? `${dest.street}, ${dest.number}` : dest.street || "",
    dest.city || "",
    dest.state || "",
  ].filter(Boolean);
  const endereco = enderecoParts.join(" · ");

  const destinatario   = task.recipients?.[0]?.name || "";
  const notasConclusao = task.completionDetails?.notes || "";

  // Tipo de pedido extraído do notes: "Tipo de Orden: VEN" / "DEV"
  const tipoMatch = (task.notes || "").match(/Tipo de Orden:\s*([A-Z]+)/i);
  const tipoCod   = tipoMatch ? tipoMatch[1].toUpperCase() : "";
  const tipoLabel = tipoCod === "DEV" ? "Devolução"
                  : tipoCod === "VEN" ? "Venda"
                  : "";

  let concluido = "";
  if (task.completionDetails?.time) {
    concluido = new Date(task.completionDetails.time)
      .toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }

  let eta = "";
  if (task.eta) {
    eta = new Date(task.eta * 1000)
      .toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }

  let dataHora = "";
  if (task.completionDetails?.time) {
    dataHora = new Date(task.completionDetails.time)
      .toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  } else if (task.timeLastModified) {
    dataHora = new Date(task.timeLastModified)
      .toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }

  return {
    ok: true,
    pedido: pedidoRaw,
    nf: pedidoRaw,
    carrier: "ONFLEET",
    statusAtual: {
      situacao: statusLabel,
      dataHora,
      unidade: endereco,
      descricao: notasConclusao,
    },
    statusCor,
    tipoCod,
    tipoLabel,
    eventos: [],
    remetente: "Luuna",
    destinatario,
    previsao: eta || concluido || "",
    trackingUrl: task.trackingURL || "",
    endereco,
    concluido,
    notasConclusao,
    eta,
    dataHora,
  };
}

// Extrai a chave de busca de um texto que contém o número do pedido.
// Pega o primeiro bloco alfanumérico após "SAL-ORD-" e normaliza (O->0, lowercase).
// Ex: "SAL-ORD-2512017411560e-2026-45f8bbde" → "2512017411560e"
//     "Sales Order-SAL-ORD-2606029b9dfd97-shipping" → "2606029b9dfd97"
//     "260602787e4d4O" (input sem prefixo) → "260602787e4d40"
function extrairChavePedido(texto) {
  const m = (texto || "").match(/SAL-?ORD-([0-9a-zA-Z]+)/i);
  if (m) return m[1].replace(/[oO]/g, "0").toLowerCase();
  return (texto || "").trim().replace(/[oO]/g, "0").toLowerCase();
}

async function buscarTaskOnfleet(chave) {
  // A organização tem México + Brasil juntos (milhares de tasks).
  // Para achar rápido, buscamos SÓ nos teams brasileiros via /teams/{id}/tasks,
  // que já retorna o campo `notes` no resumo (sem GET individual, sem rate limit).
  //
  // Pedidos são criados na semana de trabalho (seg–sex); 7 dias cobre o pior caso.
  const from = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const teamId of ONFLEET_TEAMS_BR) {
    const task = await buscarNoTeam(teamId, from, chave);
    if (task) return task;
  }

  return null;
}

// Varre as tasks de um team específico procurando a chave no campo notes.
async function buscarNoTeam(teamId, from, chave) {
  let lastId = null;
  const MAX_PAGINAS = 15; // por team

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    let url = `${ONFLEET_BASE}/teams/${teamId}/tasks?from=${from}`;
    if (lastId) url += `&lastId=${encodeURIComponent(lastId)}`;

    const resposta = await fetch(url, { headers: { Authorization: onfleetAuth() } });
    if (!resposta.ok) {
      // Se um team falhar, não derruba a busca toda — apenas pula
      return null;
    }

    const data  = await resposta.json();
    const tasks = Array.isArray(data) ? data : (data.tasks || []);
    if (tasks.length === 0) break;

    for (const task of tasks) {
      const chaveTask = extrairChavePedido(task.notes || "");
      if (chaveTask && (chaveTask === chave || chaveTask.includes(chave) || chave.includes(chaveTask))) {
        return task;
      }
    }

    const proximoLastId = Array.isArray(data) ? null : data.lastId;
    if (!proximoLastId) break;
    lastId = proximoLastId;
  }

  return null;
}


// DEBUG: rastreia um pedido nos teams BR, reportando onde está
async function debugFindPedido(pedidoRaw) {
  if (!process.env.ONFLEET_API_KEY) return { ok: false, erro: "sem API key" };

  const chaveBusca = extrairChavePedido(pedidoRaw);
  const from = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const porTeam = [];
  let achado = null;

  for (const teamId of ONFLEET_TEAMS_BR) {
    let lastId = null;
    let varridas = 0;

    for (let pagina = 0; pagina < 15; pagina++) {
      let url = `${ONFLEET_BASE}/teams/${teamId}/tasks?from=${from}`;
      if (lastId) url += `&lastId=${encodeURIComponent(lastId)}`;

      const resposta = await fetch(url, { headers: { Authorization: onfleetAuth() } });
      if (!resposta.ok) {
        porTeam.push({ teamId, erro: `HTTP ${resposta.status}` });
        break;
      }

      const data  = await resposta.json();
      const tasks = Array.isArray(data) ? data : (data.tasks || []);
      varridas += tasks.length;

      for (const task of tasks) {
        const chaveTask = extrairChavePedido(task.notes || "");
        if (chaveTask && (chaveTask === chaveBusca || chaveTask.includes(chaveBusca) || chaveBusca.includes(chaveTask))) {
          achado = {
            teamId, pagina, id: task.id, state: task.state, chaveTask,
            notesPreview: (task.notes || "").slice(0, 120),
            timeCreated: task.timeCreated ? new Date(task.timeCreated).toISOString() : null,
          };
          break;
        }
      }

      if (achado) break;
      const proximoLastId = Array.isArray(data) ? null : data.lastId;
      if (!proximoLastId || tasks.length === 0) break;
      lastId = proximoLastId;
    }

    porTeam.push({ teamId, tasksVarridas: varridas, achou: !!achado });
    if (achado) break;
  }

  return {
    ok: true,
    pedidoBuscado: pedidoRaw,
    chaveBusca,
    porTeam,
    achado: achado || "NÃO ENCONTRADO nos teams BR",
  };
}

// ═══════════════════════════════════════════════════════════════
//  SSW (Fitlog / Mira)
// ═══════════════════════════════════════════════════════════════

async function consultarCarrier(carrier, nf) {
  const senha = carrier === "FITLOG" ? SENHA_FITLOG : SENHA_MIRA;

  // Passo 1: resultSSW
  const r1 = await fetch(URL_RESULT, {
    method: "POST",
    headers: { ...COMMON_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ cnpj: CNPJ, NR: nf, chave: senha }).toString()
  });

  if (!r1.ok) return { ok: false, erro: "SSW HTTP " + r1.status, nf, carrier };

  const html1  = await r1.text();
  const tokens = extrairTokensDetalhado(html1);

  if (!tokens) {
    const dadosBasicos = parsearHtmlSswBasico(html1, nf);
    if (!dadosBasicos) return { ok: false, erro: "NF não encontrada nessa transportadora", nf, carrier };
    return {
      ok: true, nf, carrier,
      eventos: [],
      statusAtual: { dataHora: dadosBasicos.dataHora, unidade: dadosBasicos.local, situacao: dadosBasicos.situacao, descricao: "" },
      previsao: dadosBasicos.previsao || "",
      remetente: "", destinatario: "", numeroFiscal: ""
    };
  }

  // Passo 2: SSWDetalhado
  const r2 = await fetch(URL_DETALHADO, {
    method: "POST",
    headers: { ...COMMON_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id: tokens.id, md: tokens.md, w: "x" }).toString()
  });

  if (!r2.ok) return { ok: false, erro: "SSW detalhado HTTP " + r2.status, nf, carrier };

  const html2  = await r2.text();
  const detalhe = parsearDetalhado(html2);

  if (!detalhe || detalhe.eventos.length === 0) {
    return { ok: false, erro: "Falha ao extrair histórico", nf, carrier };
  }

  const statusAtual = detalhe.eventos[detalhe.eventos.length - 1];

  return {
    ok: true, nf, carrier,
    remetente:      detalhe.remetente,
    destinatario:   detalhe.destinatario,
    previsao:       detalhe.previsao,
    numeroFiscal:   detalhe.numeroFiscal,
    comprovanteUrl: detalhe.comprovanteUrl,
    eventos:        detalhe.eventos,
    statusAtual
  };
}

// ═══════════════════════════════════════════════════════════════
//  Helpers SSW
// ═══════════════════════════════════════════════════════════════

function resp(statusCode, headers, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function extrairTokensDetalhado(html) {
  const htmlDecodificado = html.replace(/&amp;/g, "&");
  const m1 = htmlDecodificado.match(/ssw_SSWDetalhado\?id=([^&'"]+)&md=([^'")]+)/);
  if (m1) return { id: m1[1], md: m1[2] };
  const idMatch = htmlDecodificado.match(/<input[^>]*\bid="id"[^>]*value\s*=\s*"([^"]+)"/i);
  const mdMatch = htmlDecodificado.match(/<input[^>]*\bid="md"[^>]*value\s*=\s*"([^"]+)"/i);
  if (idMatch && mdMatch) return { id: idMatch[1], md: mdMatch[1] };
  return null;
}

function parsearHtmlSswBasico(html, nfBuscada) {
  const nfNormalizada = String(parseInt(nfBuscada, 10));
  const blocos = html.split(/<tr[^>]+onclick=/i);
  for (let i = 1; i < blocos.length; i++) {
    const bloco = blocos[i];
    const nfMatch = bloco.match(/<label[^>]*class=["']?rastreamento["']?[^>]*>([\s\S]*?)<\/label>/i);
    if (!nfMatch) continue;
    const tokens = nfMatch[1].match(/\d{4,}/g) || [];
    let achou = false;
    for (const t of tokens) {
      if (t === nfBuscada || String(parseInt(t, 10)) === nfNormalizada) { achou = true; break; }
    }
    if (!achou && tokens.length > 1) {
      const concat = tokens.slice(1).join("");
      if (concat === nfBuscada || String(parseInt(concat, 10)) === nfNormalizada) achou = true;
    }
    if (!achou) continue;
    const localDataMatch = bloco.match(
      /<p[^>]*class=["']?tdb["']?[^>]*>\s*([\w\sÁÉÍÓÚÃÕÇáéíóúãõç\/]+?)\s*<br>\s*(\d{2}\/\d{2}\/\d{2,4})\s*(\d{2}:\d{2})/i
    );
    const local    = localDataMatch ? localDataMatch[1].trim() : "";
    const dataHora = localDataMatch ? `${localDataMatch[2]} ${localDataMatch[3]}` : "";
    const statusMatch = bloco.match(/<p[^>]*class=["']?titulo["']?[^>]*>\s*([^<]+)/i);
    const situacao = statusMatch ? statusMatch[1].trim() : "SEM STATUS";
    const prevMatch = bloco.match(/[Pp]revis[aã]o de entrega[:\s]+(\d{2}\/\d{2}\/\d{2,4})/i);
    const previsao = prevMatch ? prevMatch[1] : "";
    return { situacao, dataHora, local, previsao };
  }
  return null;
}

function parsearDetalhado(html) {
  const out = { remetente: "", destinatario: "", previsao: "", numeroFiscal: "", comprovanteUrl: "", eventos: [] };

  const decode = (s) => s
    .replace(/&atilde;/gi, "ã").replace(/&Atilde;/g, "Ã")
    .replace(/&ccedil;/gi, "ç").replace(/&Ccedil;/g, "Ç")
    .replace(/&iacute;/gi, "í").replace(/&Iacute;/g, "Í")
    .replace(/&eacute;/gi, "é").replace(/&Eacute;/g, "É")
    .replace(/&oacute;/gi, "ó").replace(/&Oacute;/g, "Ó")
    .replace(/&aacute;/gi, "á").replace(/&Aacute;/g, "Á")
    .replace(/&uacute;/gi, "ú").replace(/&Uacute;/g, "Ú")
    .replace(/&otilde;/gi, "õ").replace(/&Otilde;/g, "Õ")
    .replace(/&acirc;/gi,  "â").replace(/&ecirc;/gi,  "ê")
    .replace(/&ocirc;/gi,  "ô")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");

  const spans = [...html.matchAll(/<span[^>]*class=["']?tdb color-blue["']?[^>]*>([\s\S]*?)<\/span>/gi)];
  if (spans.length >= 1) out.remetente    = decode(stripTags(spans[0][1])).trim();
  if (spans.length >= 2) out.destinatario = decode(stripTags(spans[1][1])).trim();

  const previsaoMatch = html.match(/Previs[aã]o de entrega[:\s]*<\/span>\s*<span[^>]*color-blue[^>]*>([^<]+)</i)
                    || html.match(/Previs[aã]o de entrega[\s\S]{0,80}?(\d{2}\/\d{2}\/\d{2,4})/i);
  if (previsaoMatch) out.previsao = previsaoMatch[1].trim();

  const nfMatch = html.match(/N Fiscal[:\s]*<\/span>[\s\S]*?<span[^>]*font-weight-bold[^>]*>([^<]+)</i);
  if (nfMatch) out.numeroFiscal = stripTags(nfMatch[1]).trim().replace(/\s+/g, " ");

  const compMatch = html.match(/<a[^>]+href=["']([^"']*comprovante\?[^"']+)["'][^>]*>\s*Comprovante\s*<\/a>/i);
  if (compMatch) {
    let url = compMatch[1].replace(/&amp;/g, "&");
    if (!/^https?:\/\//i.test(url)) {
      url = url.startsWith("/") ? `https://ssw.inf.br${url}` : `https://ssw.inf.br/2/${url}`;
    }
    out.comprovanteUrl = url;
  }

  const eventoRegex = /<tr\s+class=["']mb-4[\s\S]*?<\/tr>/gi;
  const trs = html.match(eventoRegex) || [];

  for (const tr of trs) {
    const dataMatch = tr.match(/<p[^>]*class=["']?tdb["']?[^>]*>\s*(\d{2}\/\d{2}\/\d{2,4})\s*<br>\s*(\d{2}:\d{2})/i);
    if (!dataMatch) continue;
    const data = dataMatch[1].trim();
    const hora = dataMatch[2].trim();

    const pTdbs = [...tr.matchAll(/<p[^>]*class=["']?tdb["']?[^>]*>([\s\S]*?)<\/p>/gi)];
    let cidade = "", filial = "";
    if (pTdbs.length >= 2) {
      const conteudo = pTdbs[1][1];
      const matchUnidade = conteudo.match(/^\s*([^<]+?)\s*<br>\s*([^<]+?)\s*$/i);
      if (matchUnidade) {
        cidade = decode(matchUnidade[1]).trim();
        filial = decode(matchUnidade[2]).trim().replace(/\s+/g, " ");
      } else {
        cidade = decode(stripTags(conteudo)).trim();
      }
    }

    const tituloMatch = tr.match(/<p[^>]*class=["']?titulo["']?[^>]*>\s*<b>([^<]+)<\/b>/i);
    const situacao = tituloMatch ? decode(tituloMatch[1]).trim() : "";

    const descMatch = tr.match(/class=["']?titulo["']?[\s\S]*?<\/p>\s*<p[^>]*class=["']?tdb["']?[^>]*>([\s\S]*?)<\/p>/i);
    const descricao = descMatch ? decode(stripTags(descMatch[1])).trim().replace(/\s+/g, " ") : "";

    out.eventos.push({ data, hora, dataHora: `${data} ${hora}`, unidade: cidade, filial, situacao, descricao });
  }

  return out;
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, "");
}
