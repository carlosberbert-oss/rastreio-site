/**
 * Netlify Function — Proxy SSW (status + timeline completa)
 *
 * Recebe: ?carrier=FITLOG|MIRA&nf=99812
 *
 * Faz 2 chamadas:
 *   1) POST /2/resultSSW → extrai tokens id/md da NF
 *   2) POST /2/SSWDetalhado → extrai timeline completa de eventos
 *
 * Devolve JSON:
 * {
 *   ok, nf, carrier,
 *   remetente, destinatario, previsao, numeroFiscal,
 *   eventos: [
 *     { dataHora, data, hora, unidade, filial, situacao, descricao }, ...
 *   ],
 *   statusAtual: <ultimo evento>
 * }
 */

const CNPJ = process.env.CNPJ || "42418313000104";
const SENHA_FITLOG = process.env.SENHA_FITLOG || "0104";
const SENHA_MIRA   = process.env.SENHA_MIRA   || "";

const URL_RESULT    = "https://ssw.inf.br/2/resultSSW";
const URL_DETALHADO = "https://ssw.inf.br/2/SSWDetalhado";

const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
  "Origin": "https://ssw.inf.br",
  "Referer": "https://ssw.inf.br/2/rastreamento?"
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
    const params = event.queryStringParameters || {};
    const carrierParam = (params.carrier || "AUTO").toUpperCase();
    const nf = (params.nf || "").trim().replace(/\D/g, "");

    if (!nf) {
      return resp(400, corsHeaders, { ok: false, erro: "Informe a NF" });
    }

    // === Modo AUTO: tenta sequencialmente FITLOG → MIRA ===
    if (carrierParam === "AUTO") {
      const ordem = ["FITLOG", "MIRA"];
      let ultimoErro = null;

      for (const carrier of ordem) {
        try {
          const r = await consultarCarrier(carrier, nf);
          if (r && r.ok) {
            return resp(200, corsHeaders, r);
          }
          // Se foi tentado mas não achou, salva o erro e continua
          ultimoErro = r && r.erro ? r.erro : "NF não encontrada";
        } catch (e) {
          ultimoErro = e.message || "Erro na consulta";
        }
      }

      // Nenhuma transportadora achou
      return resp(200, corsHeaders, {
        ok: false,
        erro: "NF não encontrada em nenhuma transportadora",
        nf,
        carrier: "AUTO"
      });
    }

    // === Modo explícito: usa o carrier informado ===
    if (!["FITLOG", "MIRA"].includes(carrierParam)) {
      return resp(400, corsHeaders, { ok: false, erro: "Transportadora inválida" });
    }

    const resultado = await consultarCarrier(carrierParam, nf);
    return resp(200, corsHeaders, resultado);

  } catch (err) {
    return resp(500, corsHeaders, { ok: false, erro: "Exceção: " + err.message });
  }
};

/**
 * Consulta uma transportadora específica (FITLOG ou MIRA) via SSW.
 * Retorna o objeto completo de resposta ou { ok: false, erro: ... }
 */
async function consultarCarrier(carrier, nf) {
  const senha = carrier === "FITLOG" ? SENHA_FITLOG : SENHA_MIRA;

  // ====== Passo 1: consulta inicial (resultSSW) ======
  const r1 = await fetch(URL_RESULT, {
    method: "POST",
    headers: { ...COMMON_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ cnpj: CNPJ, NR: nf, chave: senha }).toString()
  });

  if (!r1.ok) {
    return { ok: false, erro: "SSW HTTP " + r1.status, nf, carrier };
  }

  const html1 = await r1.text();
  const tokens = extrairTokensDetalhado(html1);

  // Se não há link de "Mais detalhes", a NF não tem histórico/não foi encontrada
  if (!tokens) {
    // Tenta extrair pelo menos o status básico
    const dadosBasicos = parsearHtmlSswBasico(html1, nf);
    if (!dadosBasicos) {
      return { ok: false, erro: "NF não encontrada nessa transportadora", nf, carrier };
    }
    // Retorna sem timeline (NF muito recente, ainda não tem eventos)
    return {
      ok: true,
      nf, carrier,
      eventos: [],
      statusAtual: {
        dataHora: dadosBasicos.dataHora,
        unidade: dadosBasicos.local,
        situacao: dadosBasicos.situacao,
        descricao: ""
      },
      previsao: dadosBasicos.previsao || "",
      remetente: "", destinatario: "", numeroFiscal: ""
    };
  }

  // ====== Passo 2: rastreamento detalhado ======
  const r2 = await fetch(URL_DETALHADO, {
    method: "POST",
    headers: { ...COMMON_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id: tokens.id, md: tokens.md, w: "x" }).toString()
  });

  if (!r2.ok) {
    return { ok: false, erro: "SSW detalhado HTTP " + r2.status, nf, carrier };
  }

  const html2 = await r2.text();
  const detalhe = parsearDetalhado(html2);

  if (!detalhe || detalhe.eventos.length === 0) {
    return { ok: false, erro: "Falha ao extrair histórico", nf, carrier };
  }

  // Último evento = status atual
  const statusAtual = detalhe.eventos[detalhe.eventos.length - 1];

  return {
    ok: true,
    nf, carrier,
    remetente:    detalhe.remetente,
    destinatario: detalhe.destinatario,
    previsao:       detalhe.previsao,
    numeroFiscal:   detalhe.numeroFiscal,
    comprovanteUrl: detalhe.comprovanteUrl,
    eventos:      detalhe.eventos,
    statusAtual:  statusAtual
  };
}

function resp(statusCode, headers, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

/**
 * Extrai os tokens id e md do link "Mais detalhes" da página resultSSW.
 *
 * O link tem a forma:
 *   onclick="opx('/2/ssw_SSWDetalhado?id=...&amp;md=...')"
 * ou (form):
 *   <input id="id" value="...">
 *   <input id="md" value="...">
 */
function extrairTokensDetalhado(html) {
  // Decodifica entidades comuns
  const htmlDecodificado = html.replace(/&amp;/g, "&");

  // Tenta padrão onclick="opx('/2/ssw_SSWDetalhado?id=XXX&md=YYY')"
  const m1 = htmlDecodificado.match(/ssw_SSWDetalhado\?id=([^&'"]+)&md=([^'")]+)/);
  if (m1) {
    return { id: m1[1], md: m1[2] };
  }

  // Tenta padrão de inputs hidden (no caso da própria página detalhada estar embedada)
  const idMatch = htmlDecodificado.match(/<input[^>]*\bid="id"[^>]*value\s*=\s*"([^"]+)"/i);
  const mdMatch = htmlDecodificado.match(/<input[^>]*\bid="md"[^>]*value\s*=\s*"([^"]+)"/i);
  if (idMatch && mdMatch) {
    return { id: idMatch[1], md: mdMatch[1] };
  }

  return null;
}

/**
 * Parser do resultSSW (página simples) — fallback quando não tem detalhado.
 */
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
    const local = localDataMatch ? localDataMatch[1].trim() : "";
    const dataHora = localDataMatch ? `${localDataMatch[2]} ${localDataMatch[3]}` : "";

    const statusMatch = bloco.match(/<p[^>]*class=["']?titulo["']?[^>]*>\s*([^<]+)/i);
    const situacao = statusMatch ? statusMatch[1].trim() : "SEM STATUS";

    const prevMatch = bloco.match(/[Pp]revis[aã]o de entrega[:\s]+(\d{2}\/\d{2}\/\d{2,4})/i);
    const previsao = prevMatch ? prevMatch[1] : "";

    return { situacao, dataHora, local, previsao };
  }

  return null;
}

/**
 * Parser da página de Rastreamento Detalhado (SSWDetalhado).
 *
 * Extrai:
 *   - Remetente, Destinatário, NF, Previsão de entrega
 *   - Eventos (linhas de tabela com data/hora, unidade e situação)
 */
function parsearDetalhado(html) {
  const out = {
    remetente: "",
    destinatario: "",
    previsao: "",
    numeroFiscal: "",
    comprovanteUrl: "",
    eventos: []
  };

  // Decodifica entidades
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

  // === Cabeçalho ===
  // Remetente: <span class="tdb color-blue">Zebrands Comercial Ltda.</span>
  // O HTML tem ordem: Remetente vem primeiro, Destinatário depois
  const spans = [...html.matchAll(/<span[^>]*class=["']?tdb color-blue["']?[^>]*>([\s\S]*?)<\/span>/gi)];
  if (spans.length >= 1) out.remetente    = decode(stripTags(spans[0][1])).trim();
  if (spans.length >= 2) out.destinatario = decode(stripTags(spans[1][1])).trim();

  // Previsão de entrega: <span class="color-blue font-weight-bold">02/06/26</span>
  const previsaoMatch = html.match(/Previs[aã]o de entrega[:\s]*<\/span>\s*<span[^>]*color-blue[^>]*>([^<]+)</i)
                    || html.match(/Previs[aã]o de entrega[\s\S]{0,80}?(\d{2}\/\d{2}\/\d{2,4})/i);
  if (previsaoMatch) out.previsao = previsaoMatch[1].trim();

  // N Fiscal: <span class="tdb color-blue font-weight-bold">1 102819</span>
  // Pega a primeira ocorrência depois de "N Fiscal:"
  const nfMatch = html.match(/N Fiscal[:\s]*<\/span>[\s\S]*?<span[^>]*font-weight-bold[^>]*>([^<]+)</i);
  if (nfMatch) out.numeroFiscal = stripTags(nfMatch[1]).trim().replace(/\s+/g, " ");

  // Comprovante: <a href="comprovante?sigla=...&s=...&img=...">Comprovante</a>
  // Quando o comprovante existe, vem como <a> com href. Quando não tem, é um <label> sem href.
  const compMatch = html.match(/<a[^>]+href=["']([^"']*comprovante\?[^"']+)["'][^>]*>\s*Comprovante\s*<\/a>/i);
  if (compMatch) {
    let url = compMatch[1].replace(/&amp;/g, "&");
    // Se o link for relativo, vira absoluto
    if (!/^https?:\/\//i.test(url)) {
      url = url.startsWith("/") ? `https://ssw.inf.br${url}` : `https://ssw.inf.br/2/${url}`;
    }
    out.comprovanteUrl = url;
  }

  // === Eventos ===
  // Cada evento é uma <tr class="mb-4 ...">
  // Dentro tem 3 <td>: data/hora, unidade, situação+descrição
  const eventoRegex = /<tr\s+class=["']mb-4[\s\S]*?<\/tr>/gi;
  const trs = html.match(eventoRegex) || [];

  for (const tr of trs) {
    // Data/Hora — primeiro <p class=tdb>: "28/05/26<BR>21:20"
    const dataMatch = tr.match(/<p[^>]*class=["']?tdb["']?[^>]*>\s*(\d{2}\/\d{2}\/\d{2,4})\s*<br>\s*(\d{2}:\d{2})/i);
    if (!dataMatch) continue;
    const data = dataMatch[1].trim();
    const hora = dataMatch[2].trim();

    // Unidade — segundo <p class=tdb> (depois do data/hora): "GUARULHOS / SP<br>VAJ&nbsp;FIT"
    // Pegamos todas as <p class=tdb> e ignoramos a primeira (data/hora)
    const pTdbs = [...tr.matchAll(/<p[^>]*class=["']?tdb["']?[^>]*>([\s\S]*?)<\/p>/gi)];
    let cidade = "", filial = "";
    if (pTdbs.length >= 2) {
      // Segundo bloco tdb = unidade. Pode ter "CIDADE / UF<br>FILIAL"
      const conteudo = pTdbs[1][1];
      const matchUnidade = conteudo.match(/^\s*([^<]+?)\s*<br>\s*([^<]+?)\s*$/i);
      if (matchUnidade) {
        cidade = decode(matchUnidade[1]).trim();
        filial = decode(matchUnidade[2]).trim().replace(/\s+/g, " ");
      } else {
        cidade = decode(stripTags(conteudo)).trim();
      }
    }

    // Situação — <p class=titulo><b>SAIDA DE UNIDADE</b></p>
    const tituloMatch = tr.match(/<p[^>]*class=["']?titulo["']?[^>]*>\s*<b>([^<]+)<\/b>/i);
    const situacao = tituloMatch ? decode(tituloMatch[1]).trim() : "";

    // Descrição — o terceiro <p class=tdb> depois do titulo
    const descMatch = tr.match(/class=["']?titulo["']?[\s\S]*?<\/p>\s*<p[^>]*class=["']?tdb["']?[^>]*>([\s\S]*?)<\/p>/i);
    const descricao = descMatch ? decode(stripTags(descMatch[1])).trim().replace(/\s+/g, " ") : "";

    out.eventos.push({
      data,
      hora,
      dataHora: `${data} ${hora}`,
      unidade: cidade,
      filial,
      situacao,
      descricao
    });
  }

  return out;
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, "");
}
