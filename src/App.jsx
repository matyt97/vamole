import { useState, useRef, useEffect } from "react";

// ============================================================
// CONFIGURACIÓN
// ============================================================
const ENV_KEY = import.meta.env.VITE_GEMINI_API_KEY || ""; // opcional, solo para uso local (.env.local)
const KEY_STORAGE = "gemini_api_key"; // la clave del usuario se guarda solo en su navegador
const MAX_IMAGES = 4;
const MAX_SIDE = 1800; // px: se reduce la imagen para que viaje liviana y se lea bien
const ALLOWED_MIMES = ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"];
const MODEL = "gemini-3.8-flash"; // gemini-1.5-flash ya fue retirado por Google; si quieres, cámbialo aquí
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROMPT = `Eres un tutor paciente. Analiza las imágenes adjuntas, que contienen un problema o una tarea (pueden ser partes del mismo problema o problemas distintos), y responde en español con una explicación detallada paso a paso. Si son varios problemas, resuélvelos uno por uno indicando de qué imagen viene cada uno.
Formato: empieza con una línea "## Qué se pide", luego "## Paso a paso" con una lista numerada (cada paso explica qué haces y por qué), y termina con "## Respuesta final".
Escribe las fórmulas en texto plano (por ejemplo: v = d / t, x^2), sin LaTeX ni símbolos $.
Si alguna imagen no se entiende o no contiene un problema, dilo con claridad.`;

// ============================================================
// UTILIDADES
// ============================================================
const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
    reader.readAsDataURL(blob);
  });

const guessMime = (file) => {
  if (ALLOWED_MIMES.includes(file.type)) return file.type;
  const ext = file.name.split(".").pop().toLowerCase();
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", heif: "image/heif" }[ext] || null;
};

// Reduce y convierte a JPG en el navegador. Si el navegador no puede abrir el formato
// (por ejemplo HEIC en Chrome), envía el archivo original si pesa poco.
async function prepareImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob) throw new Error("canvas");
    return { mime: "image/jpeg", data: await blobToBase64(blob) };
  } catch {
    const mime = guessMime(file);
    if (!mime || file.size > 6 * 1024 * 1024) {
      throw new Error(`No se pudo leer "${file.name}". Prueba con una captura o una foto en JPG o PNG.`);
    }
    return { mime, data: await blobToBase64(file) };
  }
}

// Traduce los errores más comunes de la API
const friendlyError = (status, message = "") => {
  if (status === 400 && /api key/i.test(message)) return "La API key no es válida. Revísala y vuelve a guardarla.";
  if (status === 403) return "La API key no tiene permiso para usar este modelo o fue restringida. " + message;
  if (status === 404) return "El modelo no está disponible. Cambia la constante MODEL en src/App.jsx. " + message;
  if (status === 413) return "Las imágenes pesan demasiado. Prueba con menos imágenes o más pequeñas.";
  if (status === 429) return "Superaste el límite gratuito de Gemini. Espera un minuto e inténtalo de nuevo.";
  if (status >= 500) return "Gemini tuvo un problema temporal. Inténtalo de nuevo en un momento.";
  return message || `Error ${status} de la API.`;
};

// Quita el formato Markdown para que la voz no lea los símbolos
const cleanForSpeech = (text) =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#`]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

// Divide en frases: Chrome corta las locuciones muy largas
const splitSentences = (text) => text.match(/[^.!?;:]+[.!?;:]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [];

// ============================================================
// RENDER DE MARKDOWN (mínimo, sin dependencias)
// ============================================================
function renderInline(text, keyBase) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code key={key} style={styles.code}>
          {part.slice(1, -1)}
        </code>
      );
    return part;
  });
}

function Markdown({ text }) {
  const blocks = [];
  let list = null;
  const flush = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  text.split("\n").forEach((raw, idx) => {
    const line = raw.trim();
    const key = `b${idx}`;
    if (!line) return flush();

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push(
        <h3 key={key} style={styles.h3}>
          {renderInline(heading[2], key)}
        </h3>
      );
      return;
    }

    const ordered = line.match(/^\d+[.)]\s+(.*)$/);
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (ordered || bullet) {
      const type = ordered ? "ol" : "ul";
      if (!list || list.type !== type) {
        flush();
        list = { type, key: `l${idx}`, items: [] };
      }
      list.items.push({ key, content: (ordered || bullet)[1] });
      return;
    }

    flush();
    blocks.push(
      <p key={key} style={styles.p}>
        {renderInline(line, key)}
      </p>
    );
  });
  flush();

  return (
    <div>
      {blocks.map((b) => {
        if (b.items) {
          const Tag = b.type;
          return (
            <Tag key={b.key} style={styles.list}>
              {b.items.map((it) => (
                <li key={it.key} style={styles.li}>
                  {renderInline(it.content, it.key)}
                </li>
              ))}
            </Tag>
          );
        }
        return b;
      })}
    </div>
  );
}

// ============================================================
// COMPONENTE PRINCIPAL
// ============================================================
export default function App() {
  const [images, setImages] = useState([]); // [{ id, file, url }]
  const [solution, setSolution] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [apiKey, setApiKey] = useState(() => {
    try {
      return localStorage.getItem(KEY_STORAGE) || ENV_KEY;
    } catch {
      return ENV_KEY;
    }
  });
  const [keyDraft, setKeyDraft] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const inputRef = useRef(null);
  const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  // Libera las vistas previas y corta el audio al salir
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => imagesRef.current.forEach((im) => URL.revokeObjectURL(im.url)), []);
  useEffect(() => () => speechSupported && window.speechSynthesis.cancel(), [speechSupported]);

  const saveKey = () => {
    const k = keyDraft.trim();
    if (!k) return;
    try {
      localStorage.setItem(KEY_STORAGE, k);
    } catch {
      /* si el navegador bloquea el almacenamiento, la clave vale solo en esta sesión */
    }
    setApiKey(k);
    setKeyDraft("");
    setEditingKey(false);
    setError("");
  };

  const forgetKey = () => {
    try {
      localStorage.removeItem(KEY_STORAGE);
    } catch {
      /* nada que borrar */
    }
    setApiKey("");
    setEditingKey(false);
  };

  const addFiles = (fileList) => {
    const incoming = Array.from(fileList || []).filter((f) => f.type.startsWith("image/") || guessMime(f));
    if (!incoming.length) {
      setError("Elige imágenes (JPG, PNG, WEBP o HEIC).");
      return;
    }
    stopSpeaking();
    const room = MAX_IMAGES - images.length;
    const accepted = incoming.slice(0, Math.max(room, 0));
    setError(
      incoming.length > accepted.length
        ? `Puedes subir hasta ${MAX_IMAGES} imágenes a la vez.`
        : ""
    );
    if (!accepted.length) return;
    setSolution("");
    setImages((prev) => [
      ...prev,
      ...accepted.map((file) => ({ id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`, file, url: URL.createObjectURL(file) })),
    ]);
  };

  const removeImage = (id) => {
    setImages((prev) => {
      const gone = prev.find((im) => im.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((im) => im.id !== id);
    });
    setError("");
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const solve = async () => {
    if (!images.length || loading) return;
    if (!apiKey) {
      setError("Falta tu API key de Gemini: pégala en el campo de arriba y pulsa Guardar clave.");
      return;
    }
    stopSpeaking();
    setLoading(true);
    setError("");
    setSolution("");
    try {
      const prepared = await Promise.all(images.map((im) => prepareImage(im.file)));
      const parts = [{ text: PROMPT }];
      prepared.forEach((img, i) => {
        parts.push({ text: `Imagen ${i + 1} de ${prepared.length}:` });
        parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
      });
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ contents: [{ role: "user", parts }] }),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* respuesta sin JSON */
      }
      if (!res.ok) throw new Error(friendlyError(res.status, json?.error?.message));
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n").trim();
      if (!text) {
        const reason = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
        throw new Error(reason ? `Gemini no devolvió respuesta (${reason}). Prueba con otra imagen.` : "La API no devolvió texto.");
      }
      setSolution(text);
    } catch (err) {
      setError(err.message || "Ocurrió un error inesperado.");
    } finally {
      setLoading(false);
    }
  };

  // ---------------- Text-to-Speech ----------------
  const speakSolution = () => {
    if (!speechSupported || !solution) return;
    const synth = window.speechSynthesis;
    synth.cancel();

    const sentences = splitSentences(cleanForSpeech(solution));
    if (!sentences.length) return;
    const voice = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith("es"));

    setSpeaking(true);
    sentences.forEach((sentence, i) => {
      const u = new SpeechSynthesisUtterance(sentence);
      u.lang = "es-ES";
      u.rate = 0.65; // lento, ideal para tomar apuntes
      if (voice) u.voice = voice;
      if (i === sentences.length - 1) u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      synth.speak(u);
    });
  };

  function stopSpeaking() {
    if (!speechSupported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }

  // ---------------- UI ----------------
  return (
    <div style={styles.page}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .spinner { animation: none !important; } }
      `}</style>

      <main style={styles.container}>
        <header style={{ marginBottom: 24 }}>
          <h1 style={styles.title}>Resuelve tu tarea paso a paso</h1>
          <p style={styles.subtitle}>
            Sube una foto del problema, lee la explicación y escúchala dictada despacio para anotar.
          </p>
        </header>

        {/* API key: se guarda solo en este navegador */}
        <div style={styles.keyBox}>
          {apiKey && !editingKey ? (
            <div style={styles.keyRow}>
              <span style={{ fontSize: 14, color: "#2E6B3F", fontWeight: 600 }}>
                Clave guardada en este navegador
              </span>
              <span style={{ display: "flex", gap: 14 }}>
                <button onClick={() => setEditingKey(true)} style={styles.linkBtn}>
                  Cambiar
                </button>
                <button onClick={forgetKey} style={styles.linkBtn}>
                  Borrar
                </button>
              </span>
            </div>
          ) : (
            <div>
              <label htmlFor="apikey" style={{ display: "block", fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                Tu API key de Gemini
              </label>
              <div style={styles.keyRow}>
                <input
                  id="apikey"
                  type="password"
                  autoComplete="off"
                  placeholder="AIza..."
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveKey()}
                  style={styles.keyInput}
                />
                <button onClick={saveKey} disabled={!keyDraft.trim()} style={{ ...styles.keyBtn, opacity: keyDraft.trim() ? 1 : 0.55 }}>
                  Guardar clave
                </button>
                {apiKey && (
                  <button onClick={() => setEditingKey(false)} style={styles.linkBtn}>
                    Cancelar
                  </button>
                )}
              </div>
              <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "#4A5878" }}>
                Se guarda solo en tu navegador y nunca en el código ni en GitHub. Consíguela gratis en aistudio.google.com/apikey.
              </p>
            </div>
          )}
        </div>

        {/* Zona de carga */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Subir imágenes del problema"
          onClick={() => images.length < MAX_IMAGES && inputRef.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && images.length < MAX_IMAGES && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          style={{
            ...styles.dropzone,
            borderColor: dragging ? "#2F5BEA" : "#9AA8C7",
            background: dragging ? "#EAF0FF" : "#FFFFFF",
            cursor: images.length < MAX_IMAGES ? "pointer" : "default",
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {images.length ? (
            <div style={styles.thumbGrid}>
              {images.map((im, i) => (
                <div key={im.id} style={styles.thumb}>
                  <img src={im.url} alt={`Imagen ${i + 1}`} style={styles.thumbImg} />
                  <button
                    aria-label={`Quitar imagen ${i + 1}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeImage(im.id);
                    }}
                    style={styles.removeBtn}
                  >
                    ✕
                  </button>
                  <span style={styles.thumbName}>{im.file.name}</span>
                </div>
              ))}
              {images.length < MAX_IMAGES && (
                <div style={styles.addTile}>
                  <span style={{ fontSize: 28, lineHeight: 1 }}>+</span>
                  <span style={{ fontSize: 13 }}>Agregar</span>
                </div>
              )}
            </div>
          ) : (
            <div style={{ textAlign: "center", color: "#4A5878" }}>
              <div style={{ fontSize: 36, lineHeight: 1 }}>🖼️</div>
              <p style={{ margin: "10px 0 2px", fontWeight: 600, color: "#1B2A41" }}>
                Arrastra hasta {MAX_IMAGES} imágenes aquí
              </p>
              <p style={{ margin: 0, fontSize: 14 }}>o haz clic para elegir archivos</p>
            </div>
          )}
        </div>
        {images.length > 0 && (
          <p style={styles.fileName}>
            {images.length} de {MAX_IMAGES} imágenes
          </p>
        )}

        <button
          onClick={solve}
          disabled={!images.length || loading}
          style={{
            ...styles.primaryBtn,
            opacity: !images.length || loading ? 0.55 : 1,
            cursor: !images.length || loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? (
            <>
              <span className="spinner" style={styles.spinner} /> Resolviendo…
            </>
          ) : (
            "Resolver Problema"
          )}
        </button>

        {error && (
          <div role="alert" style={styles.error}>
            {error}
          </div>
        )}

        {/* Solución */}
        {solution && (
          <section style={styles.solution} aria-live="polite">
            <div style={styles.toolbar}>
              <button
                onClick={speakSolution}
                disabled={!speechSupported || speaking}
                style={{ ...styles.speakBtn, opacity: !speechSupported || speaking ? 0.55 : 1 }}
              >
                {speaking ? "Dictando…" : "Dictar Solución (Lento)"}
              </button>
              <button onClick={stopSpeaking} disabled={!speaking} style={{ ...styles.stopBtn, opacity: speaking ? 1 : 0.5 }}>
                Detener
              </button>
            </div>
            {!speechSupported && (
              <p style={{ ...styles.p, color: "#B3261E" }}>Tu navegador no soporta lectura en voz alta.</p>
            )}
            <Markdown text={solution} />
          </section>
        )}
      </main>
    </div>
  );
}

// ============================================================
// ESTILOS EN LÍNEA
// Fondo cuadriculado tipo cuaderno, tinta azul marino y bolígrafo azul.
// ============================================================
const styles = {
  page: {
    minHeight: "100vh",
    padding: "clamp(16px, 4vw, 40px)",
    boxSizing: "border-box",
    background: "#F4F7FB",
    backgroundImage:
      "linear-gradient(#DCE4F0 1px, transparent 1px), linear-gradient(90deg, #DCE4F0 1px, transparent 1px)",
    backgroundSize: "28px 28px",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    color: "#1B2A41",
  },
  container: { maxWidth: 760, margin: "0 auto" },
  keyBox: {
    marginBottom: 16,
    padding: "12px 14px",
    background: "#FFFFFF",
    border: "1px solid #D5DEEE",
    borderRadius: 10,
  },
  keyRow: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 },
  keyInput: {
    flex: "1 1 220px",
    padding: "10px 12px",
    border: "1.5px solid #9AA8C7",
    borderRadius: 8,
    fontSize: 15,
    minWidth: 0,
  },
  keyBtn: {
    padding: "10px 16px",
    border: "none",
    borderRadius: 8,
    background: "#1B2A41",
    color: "#fff",
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
  },
  linkBtn: {
    background: "none",
    border: "none",
    padding: 0,
    color: "#2F5BEA",
    fontSize: 14,
    fontWeight: 600,
    textDecoration: "underline",
    cursor: "pointer",
  },
  title: { margin: 0, fontSize: "clamp(1.5rem, 4.5vw, 2.1rem)", lineHeight: 1.15, letterSpacing: "-0.01em" },
  subtitle: { margin: "8px 0 0", color: "#4A5878", maxWidth: "58ch", lineHeight: 1.5 },
  dropzone: {
    border: "2px dashed",
    borderRadius: 12,
    minHeight: 190,
    padding: 16,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transition: "background 0.15s, border-color 0.15s",
    boxSizing: "border-box",
  },
  thumbGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 12, width: "100%" },
  thumb: { position: "relative", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  thumbImg: { width: "100%", height: 120, objectFit: "cover", borderRadius: 8, border: "1px solid #D5DEEE", background: "#EEF2FA" },
  thumbName: { fontSize: 12, color: "#4A5878", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  removeBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    border: "none",
    borderRadius: "50%",
    background: "rgba(27,42,65,0.85)",
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
    lineHeight: 1,
  },
  addTile: {
    height: 120,
    border: "2px dashed #9AA8C7",
    borderRadius: 8,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    color: "#4A5878",
  },
  fileName: { margin: "8px 2px 0", fontSize: 13, color: "#4A5878", wordBreak: "break-all" },
  primaryBtn: {
    marginTop: 16,
    width: "100%",
    padding: "14px 20px",
    border: "none",
    borderRadius: 10,
    background: "#2F5BEA",
    color: "#fff",
    fontSize: 16,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  spinner: {
    width: 16,
    height: 16,
    border: "2px solid rgba(255,255,255,0.4)",
    borderTopColor: "#fff",
    borderRadius: "50%",
    display: "inline-block",
    animation: "spin 0.8s linear infinite",
  },
  error: {
    marginTop: 16,
    padding: "12px 14px",
    borderRadius: 10,
    background: "#FDECEA",
    border: "1px solid #F3B8B3",
    color: "#8C1D18",
    fontSize: 14,
    lineHeight: 1.45,
  },
  solution: {
    marginTop: 24,
    padding: "clamp(16px, 3vw, 28px)",
    background: "#FFFFFF",
    border: "1px solid #D5DEEE",
    borderRadius: 12,
    boxShadow: "0 1px 3px rgba(27,42,65,0.08)",
  },
  toolbar: { display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 18 },
  speakBtn: {
    flex: "1 1 200px",
    padding: "11px 16px",
    border: "none",
    borderRadius: 8,
    background: "#FFE066",
    color: "#1B2A41",
    fontWeight: 700,
    fontSize: 15,
    cursor: "pointer",
  },
  stopBtn: {
    flex: "0 1 120px",
    padding: "11px 16px",
    border: "1.5px solid #1B2A41",
    borderRadius: 8,
    background: "transparent",
    color: "#1B2A41",
    fontWeight: 600,
    fontSize: 15,
    cursor: "pointer",
  },
  h3: { margin: "22px 0 8px", fontSize: 18, color: "#2F5BEA" },
  p: { margin: "8px 0", lineHeight: 1.65, fontSize: 16, maxWidth: "70ch" },
  list: { margin: "8px 0", paddingLeft: 24 },
  li: { margin: "8px 0", lineHeight: 1.65, fontSize: 16, maxWidth: "70ch" },
  code: {
    background: "#EEF2FA",
    padding: "1px 6px",
    borderRadius: 4,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.92em",
  },
};
