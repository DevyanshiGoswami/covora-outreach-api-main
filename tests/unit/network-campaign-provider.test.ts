import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readNetworkCampaign, NetworkReadError } from '../../src/lib/network-campaign-provider'
import { runNetworkCampaignBatch } from '../../src/lib/network-campaign-worker'
const scope={campaignId:'21',workspaceId:'31',senderIds:['41']}
const campaign={id:21,organizationUnitId:31,name:'Holiday outreach',status:'IN_PROGRESS',creationTime:'2026-10-19T12:00:00Z',campaignAccountIds:[41],progressStats:{totalUsers:47}}
const report={overallStats:[{campaignId:21,isCampaignDeleted:false,connectionsSent:25,connectionsAccepted:3,messagesSent:2,totalMessageReplies:1}]}
const now=new Date('2026-10-20T12:00:00Z')
const response=(data:unknown)=>new Response(JSON.stringify(data),{status:200})
test('reads exact workspace/campaign/senders and preserves explicit zero versus missing data',async()=>{
 const requests: {url:string,body:unknown}[]=[]
 const value=await readNetworkCampaign(scope,{apiKey:'synthetic',fetch:async(input,init)=>{requests.push({url:String(input),body:init?.body?JSON.parse(String(init.body)):null});return response(requests.length===1?campaign:report)}},now)
 assert.deepEqual(value,{name:'Holiday outreach',status:'active',totals:{leads:47,invitations_sent:25,invitations_accepted:3,messages_sent:2,replies:1}})
 assert.equal(requests.length,2)
 assert.deepEqual(requests[1].body,{campaignIds:[21],accountIds:[41],startDate:campaign.creationTime.replace('00Z','00.000Z'),endDate:now.toISOString()})
 const empty=await readNetworkCampaign(scope,{apiKey:'synthetic',fetch:async(input)=>response(String(input).includes('GetById')?campaign:{overallStats:[]})},now)
 assert.equal(empty.totals.leads,47);assert.equal(empty.totals.invitations_sent,null)
 const zero=await readNetworkCampaign(scope,{apiKey:'synthetic',fetch:async(input)=>response(String(input).includes('GetById')?campaign:{overallStats:[{campaignId:21,isCampaignDeleted:false,connectionsSent:0}]})},now)
 assert.equal(zero.totals.invitations_sent,0);assert.equal(zero.totals.replies,null)
})
test('rejects mismatched company scope before stats and rejects foreign/deleted/invalid stat results',async()=>{
 for(const bad of [{...campaign,id:22},{...campaign,organizationUnitId:32},{...campaign,campaignAccountIds:[42]},{...campaign,campaignAccountIds:[]},{...campaign,campaignAccountIds:[41,41]}]){
  let calls=0;await assert.rejects(readNetworkCampaign(scope,{apiKey:'synthetic',fetch:async()=>{calls++;return response(bad)}},now),/Network campaign read unavailable/);assert.equal(calls,1)
 }
 for(const bad of [{overallStats:[{...report.overallStats[0],campaignId:22}]},{overallStats:[{...report.overallStats[0],isCampaignDeleted:true}]},{overallStats:[{...report.overallStats[0],connectionsSent:-1}]},{overallStats:[...report.overallStats,...report.overallStats]}]){
  await assert.rejects(readNetworkCampaign(scope,{apiKey:'synthetic',fetch:async(input)=>response(String(input).includes('GetById')?campaign:bad)},now))
 }
 for(const bad of [{...scope,senderIds:[]},{...scope,campaignId:'0'},{...scope,senderIds:['41','41']}]){
  await assert.rejects(readNetworkCampaign(bad,{apiKey:'synthetic',fetch:async()=>{throw Error('must not request')}},now),/Network campaign read unavailable/)
 }
})
test('honors Retry-After without exposing response body or raw exception',async()=>{
 await assert.rejects(readNetworkCampaign(scope,{apiKey:'synthetic',fetch:async()=>new Response('secret',{status:429,headers:{'Retry-After':'180'}})},now),e=>e instanceof NetworkReadError&&e.retryAfterMs===180000&&!e.message.includes('secret'))
 await assert.rejects(readNetworkCampaign(scope,{apiKey:'synthetic',fetch:async()=>{throw Error('secret')}},now),/Network campaign read unavailable/)
})
test('one-campaign batch bounds, expired deadline, transient failure and stale config fencing',async()=>{
 const b={...scope,id:'local',clientId:'tenant',workspaceLocalId:'workspace',workspaceVersion:1,senderLocalIds:['sender'],senderVersions:[1],credentialRef:'OUTREACH_HEYREACH_TEST',attemptCount:0}
 let reads=0,saves=0,fails=0
 const deps={candidates:async()=>[b,b],timeLeft:()=>10000,markAttempt:async()=>{},credential:async()=> 'synthetic',read:async()=>{reads++;return {name:'A',status:'active',totals:{leads:1,invitations_sent:null,invitations_accepted:null,messages_sent:null,replies:null}}},save:async()=>{saves++;return true},fail:async()=>{fails++}}
 assert.deepEqual(await runNetworkCampaignBatch(deps),{campaigns:1,failed:0,deferred:0});assert.equal(reads,1);assert.equal(saves,1)
 assert.deepEqual(await runNetworkCampaignBatch({...deps,timeLeft:()=>1}),{campaigns:0,failed:0,deferred:1})
 assert.deepEqual(await runNetworkCampaignBatch({...deps,save:async()=>false}),{campaigns:0,failed:0,deferred:1})
 assert.deepEqual(await runNetworkCampaignBatch({...deps,credential:async()=>undefined}),{campaigns:0,failed:1,deferred:0});assert.equal(fails,1)
})
