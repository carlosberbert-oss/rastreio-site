/**
 * Netlify Function — Proxy SSW
 * Recebe: ?carrier=FITLOG|MIRA&nf=99812
 * Devolve JSON: { ok, status, dataHora, local, previsao }
 *
 * Por que precisa: o navegador é bloqueado por CORS ao chamar ssw.inf.br direto.
 * Essa function roda no servidor (Lambda), sem essa restrição.
 */

const CNPJ = process.env.CNPJ || "42418313000104";
const SENHA_FITLOG = process.env.SENHA_FITLOG || "0104";
const SENHA_MIRA   = process.env.SENHA_MIRA   || "";

const URL_SSW = "https://ssw.inf.br/2/resultSSW";

exports.handler = async (event) => {
  // Headers CORS — permite chamar de qualquer domínio (vamos restringir depois se quiser)
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };

  // Preflight CORS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  try {
    const params = event.queryStringParameters || {};
    const carrier = (params.carrier || "").toUpperCase();
    const nf = (params.nf || "").trim().replace(/\D/g, ""); // só dígitos

    if (!nf) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, erro: "Informe a NF" })
      };
    }

    if (!["FITLOG", "MIRA"].includes(carrier)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, erro: "Transportadora inválida (use FITLOG ou MIRA)" })
      };
    }

    const senha = carrier === "FITLOG" ? SENHA_FITLOG : SENHA_MIRA;

    // Monta corpo do POST
    const payload = new URLSearchParams({
      cnpj: CNPJ,
      NR: nf,
      chave: senha
    }).toString();

    // Faz POST no SSW
    const resp = await fetch(URL_SSW, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Origin": "https://ssw.inf.br",
        "Referer": "https://ssw.inf.br/2/rastreamento?"
      },
      body: payload
    });

    if (!resp.ok) {
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, erro: "SSW retornou HTTP " + resp.status })
      };
    }

    const html = await resp.text();
    const dados = parsearHtmlSsw(html, nf);

    if (!dados) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          erro: "NF não encontrada ou sem informação disponível",
          nf: nf,
          carrier: carrier
        })
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: true,
        nf: nf,
        carrier: carrier,
        status: dados.situacao,
        dataHora: dados.dataHora,
        local: dados.local,
        previsao: dados.previsao
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, erro: "Exceção: " + err.message })
    };
  }
};

/**
 * Parser do HTML do SSW. Retorna { situacao, dataHora, local, previsao } ou null.
 * Reaproveita a lógica do Apps Script.
 */
function parsearHtmlSsw(html, nfBuscada) {
  const nfNormalizada = String(parseInt(nfBuscada, 10));

  // Formato 1: linhas com onclick (têm rastreamento completo)
  const blocos = html.split(/<tr[^>]+onclick=/i);
  for (let i = 1; i < blocos.length; i++) {
    const bloco = blocos[i];

    const nfMatch = bloco.match(/<label[^>]*class=["']?rastreamento["']?[^>]*>([\s\S]*?)<\/label>/i);
    if (!nfMatch) continue;

    const tokens = nfMatch[1].match(/\d{4,}/g) || [];
    if (tokens.length === 0) continue;

    // Verifica se algum token bate com a NF buscada
    let achou = false;
    for (const t of tokens) {
      if (t === nfBuscada || String(parseInt(t, 10)) === nfNormalizada) {
        achou = true;
        break;
      }
    }
    if (!achou && tokens.length > 1) {
      const concat = tokens.slice(1).join("");
      if (concat === nfBuscada || String(parseInt(concat, 10)) === nfNormalizada) {
        achou = true;
      }
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

  // Formato 2: linhas SEM onclick — "Informação não disponível"
  const blocos2 = html.split(/<tr[\s>]/i);
  for (let b = 1; b < blocos2.length; b++) {
    const bloco2 = blocos2[b];
    if (bloco2.indexOf("onclick") >= 0) continue;
    if (bloco2.indexOf("rastreamento") === -1) continue;

    const nfM = bloco2.match(/<p[^>]*class=["']?tdb["']?[^>]*>\s*(\d{4,7})\s*<\/p>/i);
    if (!nfM) continue;
    if (nfM[1] !== nfBuscada && String(parseInt(nfM[1], 10)) !== nfNormalizada) continue;

    const stM = bloco2.match(/<p[^>]*class=["']?titulo["']?[^>]*>([\s\S]*?)<\/p>/i);
    if (!stM) continue;

    const sit2 = stM[1]
      .replace(/<[^>]+>/g, "")
      .trim()
      .replace(/&atilde;/gi, "ã").replace(/&ccedil;/gi, "ç")
      .replace(/&iacute;/gi, "í").replace(/&eacute;/gi, "é")
      .replace(/&oacute;/gi, "ó").replace(/&aacute;/gi, "á")
      .replace(/&amp;/gi, "&").replace(/&nbsp;/gi, " ");

    return { situacao: sit2, dataHora: "", local: "", previsao: "" };
  }

  return null;
}
