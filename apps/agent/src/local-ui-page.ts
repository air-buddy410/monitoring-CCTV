// Tokens mirror apps/web/src/app/tokens.css (DESIGN.md); the page is self-contained because it is served by the agent with a strict CSP.
const CSS = `
:root{color-scheme:light;--bg:#f3f0e8;--surface:#fbfaf6;--raised:#fff;--line:#8c8573;--line-soft:#d6d0c1;--text:#1b1913;--muted:#5a5446;--accent:#f2b13c;--on-accent:#1a1408;--accent-text:#7a4f00;--danger:#a8321f;--ok:#1f6b3a}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#11100e;--surface:#1a1915;--raised:#24221c;--line:#7d7766;--line-soft:#3a372f;--text:#efeadf;--muted:#b7af9e;--accent:#f2b13c;--on-accent:#1a1408;--accent-text:#f2b13c;--danger:#ff9b8a;--ok:#8ed9a2}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "Atkinson Hyperlegible Next",ui-sans-serif,system-ui,sans-serif;-webkit-text-size-adjust:100%}
h1,h2{margin:0;line-height:1.2;font-weight:700}
h1{font-size:clamp(1.375rem,1.2rem + 1vw,1.875rem)}
h2{font-size:clamp(1.125rem,1.05rem + .4vw,1.375rem)}
:focus-visible{outline:3px solid var(--accent-text);outline-offset:2px}
.mono{font-family:"Atkinson Hyperlegible Mono",ui-monospace,monospace;font-size:.9em;overflow-wrap:anywhere}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem 1rem;padding:1rem;border-bottom:1px solid var(--line-soft)}
.brand{font-weight:800;letter-spacing:.08em}
.sim{margin-left:auto;color:var(--muted)}
main{max-width:64rem;margin:0 auto;padding:1rem;display:grid;gap:1.5rem}
section{display:grid;gap:.75rem;padding:1rem;background:var(--surface);border:1px solid var(--line-soft);border-radius:6px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:0 1rem;border:2px solid var(--line);border-radius:6px;background:var(--raised);color:var(--text);font:inherit;font-weight:700;cursor:pointer}
.btn:hover:not(:disabled){border-color:var(--accent-text)}
.btn:disabled{cursor:not-allowed;color:var(--muted);border-style:dashed}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn-primary:hover:not(:disabled){border-color:var(--text)}
.btn-primary:active:not(:disabled){border-color:var(--text);box-shadow:inset 0 0 0 2px var(--text)}
.btn-primary:disabled{background:var(--surface);border-color:var(--line);color:var(--muted)}
label{display:block;font-weight:700;margin-bottom:.25rem}
input{display:block;width:100%;min-height:44px;padding:0 .75rem;border:2px solid var(--line);border-radius:6px;background:var(--raised);color:var(--text);font:inherit}
input[aria-invalid="true"]{border-color:var(--danger)}
.help{margin:.25rem 0 0;color:var(--muted);font-size:.9rem}
.err{margin:0;color:var(--danger);font-weight:700}
.ok{margin:0;color:var(--ok);font-weight:700}
.grid{display:grid;gap:.75rem;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))}
ul{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}
li{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:space-between;padding:.75rem;background:var(--raised);border:1px solid var(--line-soft);border-radius:6px}
.crop{position:relative}
.row{display:flex;flex-wrap:wrap;gap:.5rem}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

const JS = `
(function(){
  var csrf="";
  var $=function(id){return document.getElementById(id)};
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
  var MSG={invalid_pin:"PIN salah.",locked:"Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.",unauthorized:"Sesi berakhir. Masuk lagi.",
    device_auth_failed:"Nama pengguna atau sandi perangkat ditolak.",device_timeout:"Perangkat tidak menjawab tepat waktu.",
    device_unreachable:"Perangkat tidak terjangkau dari agen ini.",target_not_allowed:"Alamat ini tidak boleh dipakai sebagai target.",
    device_exists:"Perangkat ini sudah terdaftar.",device_no_channels:"Perangkat tidak melaporkan kanal video.",
    discovery_running:"Pencarian masih berjalan.",invalid_request:"Isian belum lengkap atau tidak valid.",device_protocol_error:"Perangkat menjawab dengan cara yang tidak dikenali."};
  function say(id,text,kind){var n=$(id);n.textContent=text||"";n.className=kind||"err";n.hidden=!text}
  async function api(method,path,body){
    var h={};
    if(body!==undefined)h["content-type"]="application/json";
    if(method!=="GET")h["x-csrf-token"]=csrf;
    var r=await fetch(path,{method:method,headers:h,body:body===undefined?undefined:JSON.stringify(body),credentials:"same-origin"});
    var data=null;
    try{data=await r.json()}catch(e){}
    if(!r.ok){var err=new Error((data&&data.code)||"error");err.status=r.status;throw err}
    return data;
  }
  function fail(id,e){say(id,MSG[e.message]||"Gagal. Kode: "+e.message)}
  function renderDevices(devices){
    var ul=$("devices");ul.textContent="";
    $("no-devices").hidden=devices.length>0;
    devices.forEach(function(d){
      var li=el("li");
      var info=el("div");
      info.appendChild(el("strong","",d.name));
      info.appendChild(el("div","mono",d.host+":"+d.port+" · "+d.brand+" "+d.model+" · "+d.cameras.length+" kamera"));
      li.appendChild(info);
      var b=el("button","btn","Hapus");b.type="button";b.setAttribute("aria-label","Hapus "+d.name);
      b.addEventListener("click",async function(){
        if(!confirm("Hapus "+d.name+" dan sandinya dari agen ini?"))return;
        try{await api("DELETE","/api/devices/"+d.deviceKey);await refresh()}catch(e){fail("add-msg",e)}
      });
      li.appendChild(b);ul.appendChild(li);
    });
  }
  async function refresh(){var s=await api("GET","/api/state");renderDevices(s.devices)}
  function useCandidate(c){
    $("host").value=c.host;$("port").value=String(c.port);
    if(c.name&&!$("name").value)$("name").value=c.name;
    $("username").focus();
  }
  function renderCandidates(list){
    var ul=$("candidates");ul.textContent="";
    $("no-candidates").hidden=list.length>0;
    list.forEach(function(c){
      var li=el("li");
      var info=el("div");
      info.appendChild(el("strong","mono",c.host+":"+c.port));
      info.appendChild(el("div","help",[c.name,c.hardware,c.location].filter(Boolean).join(" · ")||"Tanpa keterangan"));
      li.appendChild(info);
      var b=el("button","btn","Pakai");b.type="button";b.setAttribute("aria-label","Pakai "+c.host);
      b.addEventListener("click",function(){useCandidate(c)});
      li.appendChild(b);ul.appendChild(li);
    });
  }
  $("login-form").addEventListener("submit",async function(ev){
    ev.preventDefault();say("login-msg","");
    $("pin").setAttribute("aria-invalid","false");
    try{
      var r=await api("POST","/api/login",{pin:$("pin").value});
      csrf=r.csrf;$("pin").value="";
      $("login").hidden=true;$("app").hidden=false;
      await refresh();
    }catch(e){$("pin").setAttribute("aria-invalid","true");fail("login-msg",e)}
  });
  $("discover").addEventListener("click",async function(){
    var b=$("discover");b.disabled=true;say("discover-msg","Mencari perangkat ONVIF di jaringan ini...","help");
    try{var r=await api("POST","/api/discover",{});renderCandidates(r.candidates);say("discover-msg",r.candidates.length+" perangkat ditemukan.","ok")}
    catch(e){fail("discover-msg",e)}finally{b.disabled=false}
  });
  $("add-form").addEventListener("submit",async function(ev){
    ev.preventDefault();say("add-msg","");
    var b=$("add");b.disabled=true;
    var body={name:$("name").value,host:$("host").value,port:Number($("port").value),username:$("username").value,password:$("password").value};
    try{
      var r=await api("POST","/api/devices",body);
      say("add-msg","Perangkat ditambahkan: "+r.device.cameras.length+" kamera terdeteksi. Sandi tersimpan di vault agen ini saja.","ok");
      $("add-form").reset();$("port").value="80";await refresh();
    }catch(e){fail("add-msg",e)}finally{
      // the password never stays in the field after a try
      $("password").value="";b.disabled=false;
    }
  });
})();
`;

export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PANTAU Agen</title><style nonce="${nonce}">${CSS}</style></head>
<body>
<header><span class="brand">PANTAU</span><h1>Agen lokasi</h1><span class="sim">Halaman lokal. Sandi kamera tidak dikirim ke cloud.</span></header>
<main>
<section id="login" aria-labelledby="login-h">
<h2 id="login-h">Masuk dengan PIN</h2>
<p class="help">PIN tercetak di konsol agen saat dijalankan. Halaman ini hanya bisa dibuka dari komputer agen kecuali alamat LAN diatur eksplisit.</p>
<form id="login-form" autocomplete="off">
<label for="pin">PIN</label>
<input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="off" required>
<p id="login-msg" class="err" role="alert" hidden></p>
<div class="row"><button class="btn btn-primary" type="submit">Masuk</button></div>
</form>
</section>
<div id="app" hidden>
<section aria-labelledby="dev-h">
<h2 id="dev-h">Perangkat di agen ini</h2>
<p id="no-devices" class="help">Belum ada perangkat. Cari di jaringan atau isi alamat secara manual.</p>
<ul id="devices"></ul>
</section>
<section aria-labelledby="disc-h">
<h2 id="disc-h">Cari di jaringan</h2>
<p class="help">Pencarian ONVIF (WS-Discovery) hanya membaca: satu pertanyaan multicast, tanpa sandi, hanya di jaringan lokal.</p>
<div class="row"><button id="discover" class="btn" type="button">Cari perangkat</button></div>
<p id="discover-msg" class="help" role="status" hidden></p>
<p id="no-candidates" class="help" hidden>Tidak ada perangkat yang menjawab. Isi alamat secara manual di bawah.</p>
<ul id="candidates"></ul>
</section>
<section aria-labelledby="add-h">
<h2 id="add-h">Tambah perangkat</h2>
<form id="add-form" autocomplete="off">
<div class="grid">
<div><label for="name">Nama</label><input id="name" name="name" required maxlength="80" autocomplete="off"></div>
<div><label for="host">Alamat IP</label><input id="host" name="host" required maxlength="64" inputmode="decimal" autocomplete="off" class="mono"></div>
<div><label for="port">Port</label><input id="port" name="port" type="number" min="1" max="65535" value="80" required autocomplete="off"></div>
<div><label for="username">Nama pengguna perangkat</label><input id="username" name="username" required maxlength="128" autocomplete="off"></div>
<div><label for="password">Sandi perangkat</label><input id="password" name="password" type="password" required maxlength="256" autocomplete="new-password"></div>
</div>
<p class="help">Sandi langsung masuk ke vault terenkripsi di komputer ini dan tidak pernah ditampilkan lagi.</p>
<p id="add-msg" role="status" hidden></p>
<div class="row"><button id="add" class="btn btn-primary" type="submit">Uji dan simpan</button></div>
</form>
</section>
</div>
</main>
<script nonce="${nonce}">${JS}</script>
</body></html>`;
}
