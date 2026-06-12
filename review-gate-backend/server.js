// ============================================
// REVIEW GATE — Servidor Express
// Archivo: server.js
// ============================================
import express from 'express'
import cors from 'cors'
import {
  registerBusiness,
  loginBusiness,
  receiveReview,
  createSubscription,
  mpWebhook,
  getStats
} from './backend.js'

const app = express()
app.use(cors())
app.use(express.json())

// Health check
app.get('/', (req, res) => res.json({ ok: true, service: 'Review Gate API' }))

// Registro de nuevo cliente
app.post('/api/register', async (req, res) => {
  const result = await registerBusiness(req)
  res.json(result)
})

app.post('/api/login', async (req, res) => {
  const result = await loginBusiness(req)
  res.json(result)
})

// Recibir reseña desde la landing
app.post('/api/review', async (req, res) => {
  const result = await receiveReview(req)
  res.json(result)
})

// Crear suscripción MercadoPago
app.post('/api/create-subscription', async (req, res) => {
  const result = await createSubscription(req)
  res.json(result)
})

// Webhook de MercadoPago (pagos automáticos)
app.post('/api/mp-webhook', async (req, res) => {
  const result = await mpWebhook(req)
  res.json(result)
})

// Stats del dashboard
app.get('/api/stats', async (req, res) => {
  const result = await getStats(req)
  res.json(result)
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Review Gate corriendo en puerto ${PORT}`))
