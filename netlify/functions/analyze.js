'use strict';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_BYTES = 8 * 1024 * 1024;
const MODEL = 'claude-3-5-sonnet-20241022';
const ALLOWED_MIME = new Set([
  'image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif',
]);

const PROMPT = `Você é um assistente de análise cosmética visual informativa.
Analise apenas características visuais aparentes de um rosto em foto.
NÃO faça diagnóstico médico. NÃO prescreva tratamentos.
NÃO recomende procedimentos invasivos.

Responda APENAS com JSON válido, sem markdown, sem texto fora do JSON.

Schema obrigatório:
{
  "perfil": {
    "tipoPeleEstimado": "string",
    "formatoRostoEstimado": "string",
    "subtomEstimado": "string",
    "confiancaGeral": "baixa|media|alta"
  },
  "observacoes": ["string"],
  "skincare": {
    "manha": ["string","string","string","string"],
    "noite": ["string","string","string","string"]
  },
  "visagismo": {
    "cortes": ["string","string"],
    "coloracao": ["string","string","string"],
    "sobrancelha": { "estilo": "string", "dica": "string" }
  },
  "colorimetria": {
    "cartelaProvavel": "string",
    "coresPoder": ["string","string","string","string"],
    "coresEvitar": ["string","string"]
  },
  "maquiagem": {
    "batom": ["string","string","string"],
    "sombra": ["string","string"],
    "blush": "string"
  },
  "limitacoes": ["string"],
  "disclaimer": "Análise visual informativa. Não substitui avaliação dermatológica ou médica."
}`;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

function parseMultipart(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body || '', 'utf8');

  const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return null;

  const boundary = Buffer.from('--' + boundaryMatch[1]);
  const parts = [];
  let start = 0;

  while (start < raw.length) {
    const boundaryIdx = raw.indexOf(boundary, start);
    if (boundaryIdx === -1) break;
    const partStart = boundaryIdx + boundary.length;
    if (raw[partStart] === 45 && raw[partStart + 1] === 45) break;

    const headerStart = partStart + 2;
    const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;

    const headerStr = raw.slice(headerStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const nextBoundary = raw.indexOf(boundary, dataStart);
    const dataEnd = nextBoundary === -1 ? raw.length : nextBoundary - 2;
    const data = raw.slice(dataStart, dataEnd);

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const mimeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      mime: mimeMatch ? mimeMatch[1].trim() : '',
      data,
    });

    start = nextBoundary === -1 ? raw.length : nextBoundary;
  }

  return parts;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Método não permitido.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Servidor sem configuração da API.' });
  }

  let parts;
  try {
    parts = parseMultipart(event);
  } catch (e) {
    return json(400, { error: 'Requisição inválida.' });
  }

  if (!parts || parts.length === 0) {
    return json(400, { error: 'Nenhuma imagem recebida.' });
  }

  const filePart = parts.find(p => p.name === 'photo');
  if (!filePart || !filePart.data || filePart.data.length === 0) {
    return json(400, { error: 'Nenhuma imagem recebida.' });
  }

  if (filePart.data.length > MAX_BYTES) {
    return json(413, { error: 'Imagem muito grande. Máximo: 8 MB.' });
  }

  const mime = filePart.mime || 'image/jpeg';
  if (!ALLOWED_MIME.has(mime)) {
    return json(400, { error: 'Tipo de arquivo não suportado.' });
  }

  const base64Image = filePart.data.toString('base64');

  let anthropicRes;
  try {
    anthropicRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });
  } catch (e) {
    return json(502, { error: 'Não foi possível conectar ao analisador.' });
  }

  if (!anthropicRes.ok) {
    if (anthropicRes.status === 401) return json(502, { error: 'Chave da API inválida.' });
    if (anthropicRes.status === 429) return json(429, { error: 'Limite atingido. Aguarde um momento.' });
    return json(502, { error: 'Falha na análise. Tente novamente.' });
  }

  const anthropicData = await anthropicRes.json();
  const rawText = (anthropicData.content || [])
    .map(i => i.text || '')
    .join('')
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return json(502, { error: 'Resposta inválida. Tente novamente.' });
  }

  return json(200, parsed);
};
