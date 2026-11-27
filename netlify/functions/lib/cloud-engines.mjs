/**
 * Motores IA cloud ultralivianos para EduAndes AI en Netlify Functions v2:
 * - OpenAICompatibleEngine (Groq, Gemini OpenAI-compat, OpenAI, Mercury) con filtro PII
 *   automático (RUT chileno, cédula ecuatoriana, correos), limpieza de <think>, reintentos 429
 *   y control estricto de tiempo por llamada.
 * - BedrockEngine con firma AWS SigV4 nativa usando node:crypto (0 dependencias SDK, compatible
 *   con AWS_SESSION_TOKEN de AWS Learner Lab).
 */

import crypto from "node:crypto";
import { HttpError } from "./http-utils.mjs";
import { nativeStatus, rejectChatMarkers } from "./native-core.mjs";

const RUT_DNI_RE = /\b(?:\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]|\d{10})\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;

export function scrubPii(text) {
  return String(text || "")
    .replace(RUT_DNI_RE, "[ID-ANONIMIZADO]")
    .replace(EMAIL_RE, "[CORREO-ANONIMIZADO]");
}

function cleanModelOutput(raw) {
  return String(raw || "").replace(THINK_BLOCK_RE, "").trim();
}

export function liveModelName() {
  const mode = resolveEngineMode();
  if (mode === "bedrock") {
    return (process.env.EDUCORE_BEDROCK_MODEL_ID || "us.amazon.nova-lite-v1:0").trim();
  }
  return (process.env.EDUCORE_LLM_MODEL || "llama-3.3-70b-versatile").trim() || "llama-3.3-70b-versatile";
}

export function liveApiKeyMasked() {
  const key = (process.env.EDUCORE_LLM_API_KEY || "").trim();
  return key.length >= 4 ? `***${key.slice(-4)}` : "No configurada";
}

export function resolveEngineMode() {
  const mode = (process.env.EDUCORE_ENGINE || "auto").trim().toLowerCase();
  if (mode === "bedrock" || mode === "openai_compat") return mode;
  if (process.env.EDUCORE_BEDROCK_MODEL_ID && process.env.AWS_ACCESS_KEY_ID) return "bedrock";
  return "openai_compat";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CloudEngineBase {
  constructor() {
    this.reinforcement_prompt_version = "cloud-v1";
    this.parallel_safe = true;
  }

  async completeStructured(instructions, content, { creative = false, seed = 0, tokens = 750 } = {}) {
    return this.courseCompletion(instructions, content, { creative, seed, tokens });
  }

  async generate(context, answer, { maxNewTokens = 96 } = {}) {
    const instructions =
      "Redacta exactamente UNA pregunta abierta breve en español usando únicamente el contexto. " +
      "La pregunta debe poder responderse con la respuesta objetivo, sin revelar la respuesta en el enunciado. " +
      "Devuelve únicamente la pregunta.";
    const content = `Contexto:\n${String(context || "").slice(0, 4000)}\n\nRespuesta objetivo:\n${answer}`;
    return this.courseCompletion(instructions, content, { creative: false, seed: 42, tokens: maxNewTokens });
  }

  async guidance(context, question, reference, attempt, { practice = false } = {}) {
    const instructions = practice
      ? "Propón un ejercicio breve de refuerzo diferente en español usando el material, " +
        "sin repetir la pregunta original ni dar la solución."
      : "Explica en español la respuesta de referencia en 2 o 3 frases usando el material " +
        "e invita a contrastar con el intento del estudiante.";
    const content =
      `Contexto:\n${String(context || "").slice(0, 4000)}\n\nPregunta:\n${question}\n\n` +
      `Referencia:\n${reference}\n\nIntento del estudiante:\n${attempt}`;
    return this.courseCompletion(instructions, content, { creative: practice, seed: 42, tokens: 180 });
  }
}

export class OpenAICompatibleEngine extends CloudEngineBase {
  constructor({ baseUrl, apiKey, model } = {}) {
    super();
    this.baseUrl = (baseUrl || process.env.EDUCORE_LLM_BASE_URL || "https://api.groq.com/openai/v1")
      .trim()
      .replace(/\/+$/, "");
    this.apiKey = (apiKey || process.env.EDUCORE_LLM_API_KEY || "").trim();
    this.model = (model || process.env.EDUCORE_LLM_MODEL || "llama-3.3-70b-versatile").trim();
    if (!this.apiKey) {
      throw new HttpError(
        503,
        "Falta configurar EDUCORE_LLM_API_KEY en las variables de entorno de Netlify."
      );
    }
  }

  status() {
    return {
      base_model: this.model,
      base_revision: "api",
      adapter_active: false,
      adapter_version: null,
      profile: "cloud-http",
      precision: "cloud",
      device: "cloud-api",
      thinking: false,
      mode: "cloud-http",
      reinforcement_choices: "generated",
    };
  }

  async courseCompletion(instructions, content, { creative = false, seed = 42, tokens = 750 } = {}) {
    rejectChatMarkers(instructions);
    rejectChatMarkers(content);
    const safeContent = scrubPii(content);
    const payload = {
      model: this.model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: safeContent },
      ],
      max_tokens: Math.max(32, Math.floor(tokens)),
      temperature: creative ? 0.65 : 0.0,
    };

    let data = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8500);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        const text = await res.text();
        if (res.status === 429 && attempt < 2) {
          const lower = text.toLowerCase();
          if (lower.includes("billing_not_active") || lower.includes("insufficient_quota")) {
            throw new Error(`Error HTTP 429 del proveedor LLM: ${text.slice(0, 300)}`);
          }
          const retryAfter = res.headers.get("retry-after");
          let waitSec = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : 0;
          if (waitSec <= 0) {
            const m = text.match(/try again in\s*([0-9]+(?:\.[0-9]+)?)s/i);
            waitSec = m ? Number(m[1]) : 1.2 * (attempt + 1);
          }
          waitSec = Math.min(Math.max(waitSec + 0.25, 0.8), 3.0);
          await sleep(waitSec * 1000);
          continue;
        }
        if (!res.ok) {
          throw new Error(`Error HTTP ${res.status} del proveedor LLM: ${text.slice(0, 300)}`);
        }
        data = JSON.parse(text);
        break;
      } catch (err) {
        if (err.name === "AbortError") {
          if (attempt < 1) continue;
          throw new Error("Tiempo de espera agotado al consultar el proveedor LLM.");
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (!data || !Array.isArray(data.choices) || !data.choices.length) {
      throw new Error("El proveedor LLM no devolvió respuesta.");
    }
    return cleanModelOutput(data.choices[0]?.message?.content || "");
  }
}

function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256HexStr(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function signAwsV4({ method, url, region, service, body, accessKeyId, secretAccessKey, sessionToken }) {
  const parsed = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256HexStr(body);

  const headers = {
    "content-type": "application/json",
    host: parsed.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k].trim()}\n`).join("");
  const signedHeaders = sortedKeys.join(";");
  const canonicalUri = parsed.pathname
    .split("/")
    .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
    .join("/");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256HexStr(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    ...headers,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class BedrockEngine extends CloudEngineBase {
  constructor({ modelId, region } = {}) {
    super();
    this.region = (region || process.env.EDUCORE_AWS_REGION || process.env.AWS_REGION || "us-east-1").trim();
    this.modelId = (modelId || process.env.EDUCORE_BEDROCK_MODEL_ID || "us.amazon.nova-lite-v1:0").trim();
    this.accessKeyId = (process.env.AWS_ACCESS_KEY_ID || "").trim();
    this.secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || "").trim();
    this.sessionToken = (process.env.AWS_SESSION_TOKEN || "").trim();
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new HttpError(503, "Faltan AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY para Amazon Bedrock.");
    }
  }

  status() {
    return {
      base_model: this.modelId,
      base_revision: this.region,
      adapter_active: false,
      adapter_version: null,
      profile: "aws-bedrock",
      precision: "cloud",
      device: `bedrock:${this.region}`,
      thinking: false,
      mode: "cloud-bedrock",
      reinforcement_choices: "generated",
    };
  }

  async courseCompletion(instructions, content, { creative = false, tokens = 750 } = {}) {
    rejectChatMarkers(instructions);
    rejectChatMarkers(content);
    const safeContent = scrubPii(content);
    const inferenceConfig = {
      maxTokens: Math.max(32, Math.floor(tokens)),
      temperature: creative ? 0.65 : 0.0,
    };
    if (creative) inferenceConfig.topP = 0.9;

    const body = JSON.stringify({
      system: [{ text: instructions }],
      messages: [{ role: "user", content: [{ text: safeContent }] }],
      inferenceConfig,
    });
    const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.modelId)}/converse`;
    const headers = signAwsV4({
      method: "POST",
      url,
      region: this.region,
      service: "bedrock",
      body,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken || undefined,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8500);
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Error HTTP ${res.status} de Amazon Bedrock: ${text.slice(0, 300)}`);
      }
      const data = JSON.parse(text);
      const blocks = data?.output?.message?.content || [];
      return cleanModelOutput(blocks.map((b) => (b && typeof b.text === "string" ? b.text : "")).join(""));
    } finally {
      clearTimeout(timeout);
    }
  }
}

let testInjectedEngine = null;

export function setInjectedEngineForTests(engine) {
  testInjectedEngine = engine;
}

export function getEngine() {
  if (testInjectedEngine) return testInjectedEngine;
  const mode = resolveEngineMode();
  if (mode === "bedrock") return new BedrockEngine();
  return new OpenAICompatibleEngine();
}

export function engineStatus() {
  const mode = resolveEngineMode();
  const label = mode === "bedrock" ? "Amazon Bedrock (cloud)" : "Groq Cloud API";
  const modelName = liveModelName();
  const configured =
    Boolean(testInjectedEngine) ||
    (mode === "bedrock"
      ? Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
      : Boolean((process.env.EDUCORE_LLM_API_KEY || "").trim()));

  const question = configured
    ? { state: "listo", detail: `Motor cloud activo (${label} · ${modelName}).` }
    : { state: "error", detail: "Configura EDUCORE_LLM_API_KEY en Netlify Environment Variables." };

  const reinforcement = { name: mode, label, ...question };
  return {
    question_engine: question,
    reinforcement_engine: reinforcement,
    adapter_present: false,
    adapter_version: null,
    mode,
    model_name: modelName,
    native_core: nativeStatus(),
  };
}
