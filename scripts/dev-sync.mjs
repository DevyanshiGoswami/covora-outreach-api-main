// Local stand-in for the hosted cron: runs the bounded backup sync once, or every minute with --watch.
import { loadEnvFile } from 'node:process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

if (existsSync('.env.local')) loadEnvFile('.env.local')
const origin = (process.env.OUTREACH_DEV_API_ORIGIN ?? 'http://127.0.0.1:3011').replace(/\/$/, '')
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('dev:sync only calls a local backend.')
if (!process.env.CRON_SECRET) throw new Error('Set CRON_SECRET in .env.local.')

do {
  try {
    const response = await fetch(`${origin}/api/cron/outreach-sync`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } })
    console.log(`${new Date().toISOString()} sync -> ${response.status} ${await response.text()}`)
  } catch { console.log(`${new Date().toISOString()} sync -> backend unavailable at ${origin}`) }
  if (process.argv.includes('--watch')) await sleep(60_000)
} while (process.argv.includes('--watch'))
