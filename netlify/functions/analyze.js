const Anthropic = require('@anthropic-ai/sdk');

const PROMPT = `Você é um assistente de análise cosmética visual informativa.
Analise apenas características visuais aparentes de um rosto em foto.
NÃO faça diagnóstico médico. NÃO prescreva tratamentos.
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

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
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

  if (event.httpMethod !== 'POST') return resp(405, { error: 'Método não permitido.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return resp(500, { error: 'Servidor sem configuração da API.' });

  let image;
  try {
    const body = JSON.parse(event.body || '{}');
    image = body.image;
  } catch {
    return resp(400, { error: 'Requisição inválida.' });
  }

  if (!image) return resp(400, { error: 'Nenhuma imagem recebida.' });

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });

    const raw = msg.content.map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    return resp(200, parsed);

  } catch (e) {
    if (e.status === 401) return resp(502, { error: 'Chave da API inválida.' });
    if (e.status === 429) return resp(429, { error: 'Limite atingido. Aguarde um momento.' });
    return resp(502, { error: 'Falha na análise: ' + e.message });
  }
};
