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

// Nama model DeepSeek berubah-ubah (deepseek-chat dipensiunkan 24 Juli 2026).
// Isi DEEPSEEK_MODEL di server untuk memaksa satu nama; bila kosong atau ditolak,
// dicoba beberapa nama umum secara berurutan dan yang berhasil diingat.
let modelTerbukti = null
const daftarModel = () =>
  [...new Set([process.env.DEEPSEEK_MODEL, modelTerbukti, 'deepseek-v4-flash', 'deepseek-flash', 'deepseek-chat'].filter(Boolean))]

// Memanggil DeepSeek. Mengembalikan { teks } atau { galat, status }.
// Galat khusus: saldo_habis (402), kunci_tidak_valid (401), model_tidak_ada.
export async function tanyaDeepSeek({ messages, maxTokens, temperature = 0.3, waktuMs = 20000 }) {
  const alamat = process.env.DEEPSEEK_URL || 'https://api.deepseek.com/chat/completions'
  const mulai = Date.now()
  for (const model of daftarModel()) {
    const sisa = waktuMs - (Date.now() - mulai)
    if (sisa < 2000) return { galat: 'waktu_habis', status: 504 }
    const batas = new AbortController()
    const timer = setTimeout(() => batas.abort(), sisa)
    try {
      const r = await fetch(alamat, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages }),
        signal: batas.signal,
      })
      if (r.status === 402) return { galat: 'saldo_habis', status: 402 }
      if (r.status === 401) return { galat: 'kunci_tidak_valid', status: 503 }
      if (r.status === 400 || r.status === 404 || r.status === 422) continue // nama model mungkin salah
      if (!r.ok) return { galat: 'penyedia_gagal', status: 502, kodeAsal: r.status }
      const data = await r.json()
      const teks = data?.choices?.[0]?.message?.content
      if (!teks) return { galat: 'balasan_kosong', status: 502 }
      modelTerbukti = model
      return { teks }
    } catch {
      return { galat: 'waktu_habis', status: 504 }
    } finally {
      clearTimeout(timer)
    }
  }
  return { galat: 'model_tidak_ada', status: 502 }
}
