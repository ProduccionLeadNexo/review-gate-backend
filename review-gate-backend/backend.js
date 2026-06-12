// ============================================
// REVIEW GATE — Backend completo
// Deploy en: Supabase Edge Functions o Node.js
// Archivo: backend.js
// ============================================
// Instalar: npm install @supabase/supabase-js nodemailer

import { createClient } from '@supabase/supabase-js'

// ============================================
// CONFIGURACIÓN — reemplazar con tus valores
// ============================================
const CONFIG = {
  supabase: {
    url:     process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceKey: process.env.SUPABASE_SERVICE_KEY  // para operaciones admin
  },
  mercadopago: {
    accessToken:   process.env.MP_ACCESS_TOKEN,     // de tu cuenta MP Chile
    webhookSecret: process.env.MP_WEBHOOK_SECRET,
    planId:        process.env.MP_PLAN_ID,           // ID del plan de suscripción
    backUrl:       'https://reviews.leadnexo.com/pago-exitoso',
    notifUrl:      'https://reviews.leadnexo.com/api/mp-webhook'
  },
  n8n: {
    webhookUrl: process.env.N8N_WEBHOOK_URL
  },
  email: {
    from: 'alertas@leadnexo.com'
  },
  appUrl: 'https://reviews.leadnexo.com'
}

const supabase = createClient(CONFIG.supabase.url, CONFIG.supabase.serviceKey)

// ============================================
// 1. REGISTRO DE NUEVO CLIENTE
//    POST /api/register
// ============================================
export async function registerBusiness(req) {
  const { businessName, email, password, googleMapsUrl, whatsappNumber } = req.body

  // Extraer Place ID del link de Google Maps si se pega el link completo
  const placeId = extractPlaceId(googleMapsUrl)
  const slug = slugify(businessName)

  // Crear usuario en Supabase Auth
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  })
  if (authError) return { error: authError.message }

  // Crear negocio
  const { data: biz, error: bizError } = await supabase
    .from('businesses')
    .insert({
      owner_id:       authData.user.id,
      name:           businessName,
      slug,
      google_maps_url: googleMapsUrl,
      google_place_id: placeId,
      whatsapp_number: whatsappNumber,
      email_alerts:   email
    })
    .select()
    .single()
  if (bizError) return { error: bizError.message }

  // Crear trial de 14 días
  await supabase.from('subscriptions').insert({
    business_id: biz.id,
    plan: 'trial'
  })

  // URLs para compartir
  const landingUrl = `${CONFIG.appUrl}/r/${slug}`
  const waMessage  = `Hola, gracias por visitarnos 😊 Si tienes un minuto, tu opinión nos ayuda mucho: ${landingUrl} ⭐`

  // Enviar email de bienvenida con links
  await sendWelcomeEmail(email, businessName, landingUrl, waMessage)

  // Notificar a LeadNexo (para seguimiento interno)
  await notifyLeadNexo(businessName, email, whatsappNumber)

  return {
    ok: true,
    business: { id: biz.id, slug, name: businessName },
    landingUrl,
    waMessage,
    qrUrl: `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(landingUrl)}&size=300x300`
  }
}

// ============================================
// 2. LOGIN DE CLIENTE
//    POST /api/login
// ============================================
export async function loginBusiness(req) {
  const { email, password } = req.body;

  if (!email || !password) {
    return { error: "Ingresa email y contraseña." };
  }

  const { data: authData, error: authError } =
    await supabase.auth.signInWithPassword({
      email,
      password,
    });

  if (authError || !authData.user) {
    return { error: "Email o contraseña incorrectos." };
  }

  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("id, name, slug, google_maps_url, whatsapp_number, email_alerts")
    .eq("owner_id", authData.user.id)
    .single();

  if (businessError || !business) {
    return { error: "No encontramos un negocio asociado a este usuario." };
  }

  const landingUrl = `${CONFIG.appUrl}/r/${business.slug}`;
  const waMessage = `Hola, gracias por visitarnos 😊 Si tienes un minuto, tu opinión nos ayuda mucho: ${landingUrl} ⭐`;

  return {
    ok: true,
    business: {
      id: business.id,
      name: business.name,
      slug: business.slug,
    },
    landingUrl,
    waMessage,
  };
}

// ============================================
// 3. GENERAR RECOMENDACIÓN CON IA (OpenAI)
// ============================================
async function generateAiRecommendation(bizName, rating, feedback, clientName) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content: 'Eres un experto en atención al cliente para negocios locales en Chile.'
          },
          {
            role: 'user',
            content: `Un cliente dejó una reseña negativa en "${bizName}":
- Calificación: ${rating}/5 estrellas
- Cliente: ${clientName || 'Anónimo'}
- Comentario: "${feedback || 'Sin comentario'}"

Da UNA recomendación concreta y breve, máximo 2 oraciones, de cómo el dueño debe responder o actuar para recuperar a este cliente. Tono cercano y directo. Sin saludos ni formato.`
          }
        ]
      })
    })

    const data = await res.json()
    return data.choices?.[0]?.message?.content || 'Responde rápido y ofrece solucionar el problema personalmente.'
  } catch {
    return 'Responde rápido y ofrece solucionar el problema personalmente.'
  }
}

// ============================================
// 4. EMAIL DE ALERTA NEGATIVA
// ============================================
async function sendNegativeAlert(biz, review, aiTip) {
  const stars = '⭐'.repeat(review.rating) + '☆'.repeat(5 - review.rating)
  const phoneRow = review.client_phone
    ? `<tr><td style="padding:6px 0;color:#666;font-size:13px">Teléfono</td><td style="padding:6px 0;font-size:13px"><a href="tel:${review.client_phone}">${review.client_phone}</a></td></tr>`
    : ''
  const contactRow = review.wants_contact
    ? `<tr><td colspan="2" style="padding:8px 0;font-size:12px;color:#059669">✓ El cliente quiere que lo contactes</td></tr>`
    : ''

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Inter,sans-serif;background:#f7f8fa;margin:0;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
    
    <div style="background:#1A1A2E;padding:20px 24px;display:flex;align-items:center">
      <div style="color:#00D68F;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase">Review Gate · LeadNexo</div>
    </div>

    <div style="padding:24px">
      <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px 16px;margin-bottom:20px">
        <div style="font-size:13px;font-weight:600;color:#DC2626">⚠️ Reseña negativa recibida</div>
        <div style="font-size:12px;color:#B91C1C;margin-top:2px">Protegimos tu perfil de Google — esta reseña no apareció públicamente.</div>
      </div>

      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#666;font-size:13px">Negocio</td><td style="padding:6px 0;font-size:13px;font-weight:500">${biz.name}</td></tr>
        <tr><td style="padding:6px 0;color:#666;font-size:13px">Calificación</td><td style="padding:6px 0;font-size:13px">${stars} (${review.rating}/5)</td></tr>
        <tr><td style="padding:6px 0;color:#666;font-size:13px">Cliente</td><td style="padding:6px 0;font-size:13px">${review.client_name || 'Anónimo'}</td></tr>
        ${phoneRow}
        <tr><td style="padding:6px 0;color:#666;font-size:13px">Fecha</td><td style="padding:6px 0;font-size:13px">${new Date().toLocaleString('es-CL')}</td></tr>
        ${contactRow}
      </table>

      ${review.feedback ? `
      <div style="margin:16px 0;background:#F9FAFB;border-radius:8px;padding:14px;font-size:13px;color:#374151;line-height:1.6;font-style:italic">
        "${review.feedback}"
      </div>` : ''}

      ${aiTip ? `
      <div style="margin:16px 0;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:14px">
        <div style="font-size:11px;font-weight:600;color:#1D4ED8;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">💡 Recomendación IA</div>
        <div style="font-size:13px;color:#1E3A5F;line-height:1.6">${aiTip}</div>
      </div>` : ''}

      <div style="margin:16px 0;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:12px 14px">
        <div style="font-size:12px;color:#166534">🛡️ <strong>Perfil protegido:</strong> Esta reseña no llegó a Google. Solo tú la puedes ver en tu dashboard.</div>
      </div>

      <a href="${CONFIG.appUrl}/dashboard" style="display:inline-block;background:#1A1A2E;color:#00D68F;padding:11px 22px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;margin-top:8px">Ver en dashboard →</a>
    </div>

    <div style="padding:14px 24px;background:#F9FAFB;border-top:1px solid #E5E7EB">
      <div style="font-size:11px;color:#9CA3AF">LeadNexo · Review Gate — Sistema de protección de reputación</div>
    </div>
  </div>
</body>
</html>`

  // Enviar vía n8n (ya configurado)
  await fetch(CONFIG.n8n.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'negative_review',
      to: biz.email_alerts,
      subject: `⚠️ Reseña negativa en ${biz.name} — ${review.rating}★ (perfil protegido)`,
      html,
      whatsapp: biz.whatsapp_number,
      waMessage: `⚠️ *Reseña negativa — ${biz.name}*\n\n${stars} ${review.rating}/5\n👤 ${review.client_name || 'Anónimo'}${review.client_phone ? '\n📞 ' + review.client_phone : ''}\n💬 _${review.feedback || 'Sin comentario'}_\n\n💡 ${aiTip}\n\n🛡️ Protegimos tu perfil de Google.`
    })
  }).catch(() => {})
}

// ============================================
// 5. EMAIL DE BIENVENIDA
// ============================================
async function sendWelcomeEmail(email, bizName, landingUrl, waMsg) {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(landingUrl)}&size=200x200`
  const html = `
<!DOCTYPE html><html><body style="font-family:Inter,sans-serif;background:#f7f8fa;margin:0;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
    <div style="background:#1A1A2E;padding:20px 24px"><div style="color:#00D68F;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em">Review Gate · LeadNexo</div></div>
    <div style="padding:28px">
      <h2 style="font-size:20px;margin:0 0 8px;color:#111">¡Bienvenido, ${bizName}! 🎉</h2>
      <p style="font-size:13px;color:#666;margin:0 0 20px;line-height:1.6">Tu sistema de reseñas está activo. Tienes <strong>14 días gratis</strong> para probarlo.</p>
      <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:14px;margin-bottom:20px;font-size:13px;color:#166534">
        🛡️ A partir de ahora, las reseñas negativas <strong>no llegarán a Google</strong>. Solo tú las verás en tu dashboard.
      </div>
      <div style="margin-bottom:16px">
        <div style="font-size:12px;color:#666;margin-bottom:6px;font-weight:500">Tu link de reseñas</div>
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:10px 12px;font-family:monospace;font-size:12px;color:#374151">${landingUrl}</div>
      </div>
      <div style="text-align:center;margin:20px 0">
        <img src="${qrUrl}" style="width:140px;height:140px;border-radius:8px">
        <div style="font-size:11px;color:#9CA3AF;margin-top:6px">Imprime este QR y ponlo en tu local</div>
      </div>
      <div style="background:#EFF6FF;border-radius:8px;padding:14px;margin-bottom:20px">
        <div style="font-size:11px;font-weight:600;color:#1D4ED8;margin-bottom:6px">📲 Mensaje listo para WhatsApp</div>
        <div style="font-size:12px;color:#1E3A5F;line-height:1.6">${waMsg}</div>
      </div>
      <a href="${CONFIG.appUrl}/dashboard" style="display:inline-block;background:#00D68F;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">Ir a mi dashboard →</a>
    </div>
  </div>
</body></html>`

  await fetch(CONFIG.n8n.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'welcome', to: email, subject: `¡Bienvenido a Review Gate, ${bizName}!`, html })
  }).catch(() => {})
}

// ============================================
// 6. MERCADOPAGO — Crear suscripción
//    POST /api/create-subscription
// ============================================
export async function createSubscription(req) {
  const { businessId, payerEmail } = req.body

  const res = await fetch('https://api.mercadopago.com/preapproval', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.mercadopago.accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      preapproval_plan_id: CONFIG.mercadopago.planId,
      reason:              'Review Gate — LeadNexo',
      payer_email:         payerEmail,
      back_url:            CONFIG.mercadopago.backUrl,
      notification_url:    CONFIG.mercadopago.notifUrl,
      status:              'pending'
    })
  })

  const mp = await res.json()

  // Guardar ID en Supabase para seguimiento
  await supabase.from('subscriptions')
    .update({
      mp_preapproval_id: mp.id,
      mp_payer_email:    payerEmail
    })
    .eq('business_id', businessId)

  return { ok: true, checkoutUrl: mp.init_point }
}

// ============================================
// 7. MERCADOPAGO — Webhook de pagos
//    POST /api/mp-webhook
// ============================================
export async function mpWebhook(req) {
  const { type, data } = req.body
  if (type !== 'subscription_preapproval') return { ok: true }

  const res = await fetch(`https://api.mercadopago.com/preapproval/${data.id}`, {
    headers: { 'Authorization': `Bearer ${CONFIG.mercadopago.accessToken}` }
  })
  const mp = await res.json()

  const planMap = { authorized: 'active', cancelled: 'cancelled', paused: 'cancelled' }
  const newPlan = planMap[mp.status] || null
  if (!newPlan) return { ok: true }

  await supabase.from('subscriptions')
    .update({ plan: newPlan, next_billing_at: mp.next_payment_date })
    .eq('mp_preapproval_id', data.id)

  return { ok: true }
}

// ============================================
// 8. STATS DASHBOARD
//    GET /api/stats?businessId=xxx&days=30
// ============================================
export async function getStats(req) {
  const { businessId, days = 30 } = req.query

  const { data } = await supabase
    .rpc('get_business_stats', { p_business_id: businessId, p_days: parseInt(days) })

  const { data: reviews } = await supabase
    .from('reviews')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(50)

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('business_id', businessId)
    .single()

  return { stats: data, reviews, subscription: sub }
}

// ============================================
// HELPERS
// ============================================
function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
}

function extractPlaceId(url) {
  if (!url) return null
  const m = url.match(/placeid=([^&]+)/) || url.match(/place_id=([^&]+)/)
  return m ? m[1] : null
}

async function sendPositiveNotification(biz, rating) {
  // Opcional: notificación celebratoria al dueño
  // Por defecto desactivada para no saturar
}

async function notifyLeadNexo(bizName, email, phone) {
  // Notificación interna a Claudio cuando se registra un nuevo cliente
  await fetch(CONFIG.n8n.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'new_client',
      waMessage: `🎉 *Nuevo cliente registrado*\n\n🏪 ${bizName}\n📧 ${email}\n📞 ${phone || 'no indicado'}\n\nTrial de 14 días activado.`
    })
  }).catch(() => {})
}
