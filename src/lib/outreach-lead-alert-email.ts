import 'server-only'

import { escapeHtml } from '@/lib/html'
import { outreachPortalOrigin } from '@/lib/outreach-portal-origin'

type LeadAlertEmailInput = {
  leadCount: number
  clientId: string
  portalOrigin: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BODY = 'Head to your Covora portal to see their replies and keep the conversation going.'

function inboxUrl(input: LeadAlertEmailInput): string {
  if (typeof input.clientId !== 'string' || !UUID.test(input.clientId)) {
    throw new Error('Invalid client ID for lead alert')
  }

  const origin = outreachPortalOrigin(input.portalOrigin)
  if (!origin) throw new Error('Invalid portal origin for lead alert')

  const url = new URL('/', origin)
  url.searchParams.set('client', input.clientId)
  url.searchParams.set('view', 'inbox')
  return url.toString()
}

/** Pure rendering only: recipient selection and delivery belong to the worker. */
export function renderLeadAlertEmail(input: LeadAlertEmailInput): {
  subject: string
  html: string
  text: string
} {
  if (!Number.isInteger(input.leadCount) || input.leadCount < 1 || input.leadCount > 10_000) {
    throw new Error('Invalid lead count: expected an integer from 1 to 10000')
  }
  const url = inboxUrl(input)
  const subject = input.leadCount === 1
    ? 'You have 1 new lead that wants to hear from you!'
    : `You have ${input.leadCount} new leads that want to hear from you!`

  return {
    subject,
    text: `${subject}\n\n${BODY}\n\nView your leads: ${url}\n\nCovora`,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f2f5fa;color:#112340;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:#f2f5fa;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;border-collapse:separate;border-spacing:0;">
            <tr>
              <td style="padding:25px 32px;background-color:#10213d;border-radius:16px 16px 0 0;border-bottom:3px solid #4776ed;">
                <p style="margin:0;color:#ffffff;font-size:24px;line-height:30px;font-weight:700;letter-spacing:-0.6px;">Covora<span style="color:#729bff;">.</span></p>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px 40px;background-color:#ffffff;border-right:1px solid #e1e7f0;border-left:1px solid #e1e7f0;">
                <p style="margin:0 0 16px;color:#426bd0;font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.6px;">NEW LEADS</p>
                <h1 style="margin:0 0 20px;color:#112340;font-size:30px;line-height:38px;font-weight:700;letter-spacing:-0.7px;">${escapeHtml(subject)}</h1>
                <p style="margin:0 0 28px;color:#607087;font-size:16px;line-height:26px;">${escapeHtml(BODY)}</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
                  <tr>
                    <td align="center" bgcolor="#3564df" style="background-color:#3564df;border:1px solid #3564df;border-radius:8px;mso-padding-alt:15px 25px;">
                      <a href="${escapeHtml(url)}" style="display:inline-block;padding:15px 25px;color:#ffffff;font-size:15px;line-height:20px;font-weight:700;text-decoration:none;border-radius:8px;">View your leads</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;background-color:#fafbfd;border:1px solid #e1e7f0;border-radius:0 0 16px 16px;">
                <p style="margin:0;color:#8390a3;font-size:12px;line-height:18px;">Your Covora portal</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  }
}
