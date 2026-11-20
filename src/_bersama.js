// Pembantu bersama untuk fungsi server (awalan _ berarti bukan alamat publik di Vercel).
// Kunci API hanya dibaca dari DEEPSEEK_API_KEY di server; jangan pakai awalan VITE_.

export const potong = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export function kirim(res, status, isi) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(isi))
}

export async function bacaBadan(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  }
  const bagian = []
  let total = 0
  for await (const b of req) {
    total += b.length
    if (total > 30000) throw new Error('terlalu_besar')
    bagian.push(b)
  }
  return JSON.parse(Buffer.concat(bagian).toString('utf8') || '{}')
}

// true bila permintaan datang dari situs lain.
export function asalDitolak(req) {
  const asal = req.headers.origin
  if (!asal) return false
  try {
    return new URL(asal).host !== req.headers.host
  } catch {
    return true
  }
}

// Pembatas kecepatan sederhana per IP dan per fungsi (berlaku per instans server).
const catatan = new Map()
export function terlaluSering(req, nama, maks) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim()
  const kunci = `${nama}:${ip}`
  const sekarang = Date.now()
  const daftar = (catatan.get(kunci) || []).filter((t) => sekarang - t < 10 * 60 * 1000)
  if (daftar.length >= maks) {
    catatan.set(kunci, daftar)
    return true
  }
  daftar.push(sekarang)
  catatan.set(kunci, daftar)
  if (catatan.size > 5000) catatan.clear()
  return false
}

// Penyedia AI: Gemini (Google) atau DeepSeek. Dipilih lewat AI_PROVIDER; bila kosong,
// dipakai Gemini kalau GEMINI_API_KEY terisi, selain itu DeepSeek. Keduanya memakai
// format "chat completions" yang sama, jadi satu fungsi cukup.
// Nama model sering berganti, jadi beberapa nama dicoba berurutan dan yang berhasil diingat.
function penyedia() {
  const e = process.env
  const pilih = (e.AI_PROVIDER || (e.GEMINI_API_KEY ? 'gemini' : 'deepseek')).toLowerCase()
  if (pilih === 'gemini') {
    return {
      nama: 'gemini',
      kunci: e.GEMINI_API_KEY,
      alamat: e.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      model: [e.GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'],
      // Model Gemini "berpikir" dulu; dibuat ringan agar cepat dan tidak menghabiskan batas token.
      tambahan: { reasoning_effort: 'low' },
      kaliToken: 3,
    }
  }
  return {
    nama: 'deepseek',
    kunci: e.DEEPSEEK_API_KEY,
    alamat: e.DEEPSEEK_URL || 'https://api.deepseek.com/chat/completions',
    // deepseek-chat dipensiunkan 24 Juli 2026.
    model: [e.DEEPSEEK_MODEL, 'deepseek-v4-flash', 'deepseek-flash', 'deepseek-chat'],
    tambahan: {},
    kaliToken: 1,
  }
}

export const adaKunci = () => Boolean(penyedia().kunci)

const terbukti = {}

// Memanggil penyedia AI. Mengembalikan { teks } atau { galat, status }.
// Galat khusus: saldo_habis (402), kuota_habis (429), kunci_tidak_valid, model_tidak_ada.
export async function tanyaAI({ messages, maxTokens, temperature = 0.3, waktuMs = 20000 }) {
  const p = penyedia()
  const daftar = [...new Set([p.model[0], terbukti[p.nama], ...p.model.slice(1)].filter(Boolean))]
  const mulai = Date.now()
  for (const model of daftar) {
    const sisa = waktuMs - (Date.now() - mulai)
    if (sisa < 2000) return { galat: 'waktu_habis', status: 504 }
    const batas = new AbortController()
    const timer = setTimeout(() => batas.abort(), sisa)
    try {
      const r = await fetch(p.alamat, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.kunci}` },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens * p.kaliToken,
          messages,
          ...p.tambahan,
        }),
        signal: batas.signal,
      })
      if (r.status === 402) return { galat: 'saldo_habis', status: 402 }
      if (r.status === 401 || r.status === 403) return { galat: 'kunci_tidak_valid', status: 503 }
      if (r.status === 429) return { galat: 'kuota_habis', status: 429 }
      if (r.status === 400 || r.status === 404 || r.status === 422) {
        const isi = await r.text().catch(() => '')
        if (/api[_ ]key/i.test(isi)) return { galat: 'kunci_tidak_valid', status: 503 }
        continue // nama model atau parameter mungkin tidak dikenal
      }
      if (!r.ok) return { galat: 'penyedia_gagal', status: 502, kodeAsal: r.status }
      const data = await r.json()
      const teks = data?.choices?.[0]?.message?.content
      if (!teks) return { galat: 'balasan_kosong', status: 502 }
      terbukti[p.nama] = model
      return { teks }
    } catch {
      return { galat: 'waktu_habis', status: 504 }
    } finally {
      clearTimeout(timer)
    }
  }
  return { galat: 'model_tidak_ada', status: 502 }
}

// Nama lama dipertahankan agar kode dan uji yang ada tetap jalan.
export const tanyaDeepSeek = tanyaAI
