import assert from 'node:assert/strict'
import test from 'node:test'
import {linkedinCookies,linkedinProfileUrl} from '../../src/lib/linkedin-session'
const valid=[{name:'li_at',value:'synthetic',domain:'.linkedin.com',path:'/'},{name:'JSESSIONID',value:'"ajax:synthetic"',domain:'.linkedin.com',path:'/'}]
test('only a bounded LinkedIn authentication cookie pair is accepted',()=>{
 assert.ok(linkedinCookies.safeParse(valid).success)
 for(const rows of [[],[valid[0]], [valid[0],valid[0]], [...valid,valid[0]], [{...valid[0],domain:'.evil.test'},valid[1]], [{...valid[0],value:'a\nsecret'},valid[1]], [{...valid[0],value:'x'.repeat(2049)},valid[1]], [{...valid[0],unexpected:'data'},valid[1]]])assert.equal(linkedinCookies.safeParse(rows).success,false)
})
test('public profile matching canonicalizes only LinkedIn member URLs',()=>{
 assert.equal(linkedinProfileUrl('https://linkedin.com/in/Person-123/?trk=test'),'https://www.linkedin.com/in/person-123')
 for(const url of ['http://linkedin.com/in/person','https://linkedin.com.evil.test/in/person','https://user:pass@linkedin.com/in/person','https://www.linkedin.com/company/test','https://www.linkedin.com/in/person/extra','https://www.linkedin.com:444/in/person'])assert.throws(()=>linkedinProfileUrl(url))
})
