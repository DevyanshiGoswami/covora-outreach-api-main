import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { cloudEnvironment, authUrl } from './cloud-development-config.mjs';

// Maintainer-only, dev-project-bound onboarding. No emails, copied identities or provider data.
try {
  const email = process.argv[2]?.trim().toLowerCase();
  if (process.argv.length !== 3 || !email || !/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) throw new Error('Pass one developer email to seed:cloud.');
  const env = cloudEnvironment(parseEnv(await readFile('.env.cloud.local', 'utf8')));
  const destination = `.artifacts/cloud-login-${email}.json`;
  try { await access(destination); throw new Error('A private login record already exists. It was preserved.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const admin = createClient(authUrl, env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false,autoRefreshToken:false} });
  const check = result => { if (result.error) throw new Error('Development seed operation failed. Inspect the development database before retrying.'); return result.data; };
  const hash = text => createHash('sha256').update(text).digest('hex');
  const workspaces = [
    {id:'d0000000-0000-4000-8000-000000000001', slug:'covora-development', name:'Covora · Development'},
    {id:'d0000000-0000-4000-8000-000000000002', slug:'sample-workspace-development', name:'Sample workspace · Development'},
  ];
  for (let index=0; index<workspaces.length; index++) {
    const client = workspaces[index];
    check(await admin.from('clients').upsert(client,{onConflict:'id',ignoreDuplicates:true}));
    check(await admin.from('client_features').upsert({client_id:client.id,feature:'outreach_app',enabled:true},{onConflict:'client_id,feature',ignoreDuplicates:true}));
    const listId=`d1000000-0000-4000-8000-00000000000${index+1}`;
    check(await admin.from('outreach_lead_lists').upsert({id:listId,client_id:client.id,name:'Synthetic development leads',source_sha256:hash('covora-development-fixtures-v1')},{onConflict:'id',ignoreDuplicates:true}));
    for (const [i, first_name] of ['Alex','Taylor','Jordan'].entries()) {
      check(await admin.from('outreach_imported_leads').upsert({id:`d2000000-0000-4000-8000-0000000000${index+1}${i+1}`,client_id:client.id,list_id:listId,source_row_id:hash(`${index}-${i}-dev`),first_name,last_name:'Sample',company:'Example Company (synthetic)',job_title:['Founder','Marketing Director','Operations Manager'][i],email:`${first_name.toLowerCase()}-${index}@example.test`,email_verification:'unknown',review_state:'client',location:'Sample location',role_category:['owners-executives','vp-director','manager-other'][i]}, {onConflict:'id',ignoreDuplicates:true}));
    }
  }
  const password = randomBytes(24).toString('base64url');
  const created = check(await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{environment:'development'}}));
  if (!created.user) throw new Error('Could not create developer identity. Existing accounts are never reset.');
  // Save immediately so partial membership failures never lose the generated login.
  await mkdir('.artifacts',{recursive:true,mode:0o700});
  await writeFile(destination, JSON.stringify({url:'http://127.0.0.1:3003/login',authUrl,email,password,userId:created.user.id,environment:'development',note:'Separate development password. No email was sent. Share privately with this developer only.'},null,2)+'\n',{mode:0o600,flag:'wx'});
  check(await admin.from('profiles').upsert({id:created.user.id,full_name:email.split('@')[0]}));
  check(await admin.from('outreach_agency_memberships').insert({user_id:created.user.id,role:'owner',state:'active'}));
  console.log(`Development account and synthetic leads ready. Private login: ${destination}`);
} catch (error) { console.error(error.message); process.exitCode=1; }
