/* Test-only JSON-RPC host with synthetic files; this is not the ChatGPT host. */
(() => {
  const frame = document.getElementById('app');
  const options = new URLSearchParams(location.search);
  if (options.has('overlay')) document.getElementById('composer-overlay').hidden = false;
  const hostDownload = options.get('hostDownload') !== '0';
  const initial = options.get('initial') || '/Mac';
  const binary = Uint8Array.from({ length: 600123 }, (_, i) => i % 256);
  const pixelBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmYQAAAAASUVORK5CYII=';
  const pixel = Uint8Array.from(atob(pixelBase64), c=>c.charCodeAt(0));
  const pdf = new TextEncoder().encode('%PDF-1.4\n% synthetic preview fixture\n');
  const pdfVersion = 'a'.repeat(64);
  const readme = options.has('long') ? 'A synthetic project note.\n'.repeat(300) : 'A synthetic project note. Search finds exact words and previews text.\n';
  const files = [
    {name:'Projects',path:'/Mac/Projects',kind:'directory',size:null,modified:'2026-01-01T00:00:00.000Z'},
    {name:'README.md',path:'/Mac/README.md',kind:'file',size:new TextEncoder().encode(readme).length,modified:'2026-01-01T00:00:00.000Z'},
    {name:'sample.bin',path:'/Mac/sample.bin',kind:'file',size:binary.length,modified:'2026-01-01T00:00:00.000Z'},
    {name:'pixel.png',path:'/Mac/pixel.png',kind:'file',size:pixel.length,modified:'2026-01-01T00:00:00.000Z'},
    {name:'document.pdf',path:'/Mac/document.pdf',kind:'file',size:pdf.length,modified:'2026-01-01T00:00:00.000Z'}
  ];
  const state = window.mockHost = { requests: [], messages: [], downloads: [], errors: [], initialized: false };
  function send(payload) { frame.contentWindow.postMessage(payload, '*'); }
  function entries(path) { return path === '/Mac/Projects' ? [] : files; }
  function content(o) { return {content:[{type:'text',text:JSON.stringify(o)}], structuredContent:o}; }
  function browse(args) {
    const path = args.path || '/Mac';
    const all = entries(path);
    const offset = args.offset || 0;
    const limit = args.limit || 100;
    return content({path,home:'/Mac',parent:path === '/Mac' ? null : '/Mac',entries:all.slice(offset, offset + limit),next_offset:offset + limit < all.length ? offset + limit : null});
  }
  function search(args) {
    const query = String(args.query || '').toLowerCase();
    const matches = files.filter(f => f.name.toLowerCase().includes(query) || (args.mode === 'content' && f.name === 'README.md' && readme.toLowerCase().includes(query)));
    const incomplete=query==='missing';
    return content({root:args.root || '/Mac',query:args.query,mode:args.mode,entries:matches,scanned:files.length,truncated:incomplete,errors:incomplete?1:0,skipped_binary:incomplete?2:0,skipped_symlinks:incomplete?1:0});
  }
  function read(args) {
    const found=files.find(f=>f.path===args.path);
    if(!found) throw Error('No such file');
    if(found.kind!=='file') throw Error('Not a file');
    const isText=found.name==='README.md';
    const mime=isText?'text/markdown':found.name==='pixel.png'?'image/png':found.name==='document.pdf'?'application/pdf':'application/octet-stream';
    return content({path:found.path,name:found.name,size:found.size,mime_type:mime,kind:isText?'text':'binary',...(isText?{content:readme}:{}),truncated:false});
  }
  function chunk(args) {
    const data = args.path === '/Mac/sample.bin' ? binary : args.path === '/Mac/pixel.png' ? pixel : args.path === '/Mac/document.pdf' ? pdf : new TextEncoder().encode(readme);
    const offset = args.offset || 0;
    if (offset > 0 && args.expected_version !== 'fixture-v1') throw Error('Version mismatch');
    const bytes = data.slice(offset, offset + Math.min(args.length || 262144,262144));
    let raw=''; for (let i=0;i<bytes.length;i+=8192) raw += String.fromCharCode(...bytes.subarray(i,i+8192));
    const version=options.has('changed') && offset>0 ? 'fixture-v2' : 'fixture-v1';
    const metadata={path:args.path,name:args.path.split('/').at(-1),size:data.length,offset,length:bytes.length,next_offset:offset+bytes.length,eof:offset+bytes.length>=data.length,mime_type:'application/octet-stream',version};
    return {...content(metadata),_meta:{data_base64:btoa(raw)}};
  }
  async function dispatch(method, params) {
    switch(method) {
      case 'ui/initialize': return {protocolVersion:'2026-01-26',hostInfo:{name:'Synthetic local host',version:'1.0.0'},hostCapabilities:{serverTools:{},message:{text:{}},openLinks:{},...(hostDownload?{downloadFile:{}}:{})},hostContext:{theme:'light',displayMode:options.has('overlay')?'fullscreen':'inline',availableDisplayModes:['inline','fullscreen'],platform:'mobile',deviceCapabilities:{touch:true,hover:false},containerDimensions:{maxWidth:390,maxHeight:800},safeAreaInsets:{top:0,right:0,bottom:20,left:0}}};
      case 'tools/call':
        if(params.name==='open_browser' || params.name==='browse_directory') return browse(params.arguments||{});
        if(params.name==='search_files') return search(params.arguments||{});
        if(params.name==='read_file') return read(params.arguments||{});
        if(params.name==='read_pdf_page') {
          if(options.has('pdfError')) return {isError:true,content:[{type:'text',text:'Synthetic PDF renderer unavailable'}]};
          const page=Number(params.arguments?.page||1);
          if(page<1 || page>2) throw Error('Page outside fixture');
          if(page>1 && params.arguments?.expected_version!==pdfVersion) throw Error('PDF version was not pinned');
          if(options.has('pdfChanged') && page>1) return {isError:true,content:[{type:'text',text:'PDF file changed'}]};
          return {...content({path:params.arguments.path,name:'document.pdf',mime_type:'image/png',page,pages:2,width:1,height:1,version:pdfVersion}),_meta:{data_base64:pixelBase64}};
        }
        if(params.name==='read_file_chunk') {
          if(options.has('delayChunks')) await new Promise(resolve=>setTimeout(resolve,700));
          const result=chunk(params.arguments||{}); state.chunkResponses=(state.chunkResponses||0)+1; return result;
        }
        throw Error('Unknown tool: '+params.name);
      case 'ui/message': state.messages.push(params); return {};
      case 'ui/download-file': {
        if(!hostDownload) throw Error('Host download not supported');
        const resource=params.contents?.[0]?.resource;
        const raw=resource?.blob ? atob(resource.blob) : '';
        const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
        const expected=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',binary)),x=>x.toString(16).padStart(2,'0')).join('');
        state.downloads.push({name:resource?.uri||null,length:bytes.length,digest,expected,exact:digest===expected});
        return {};
      }
      case 'ui/request-display-mode': return {mode:params.mode};
      case 'ui/open-link': return {isError:true};
      case 'ui/update-model-context': return {};
      default: throw Error('Unhandled method: '+method);
    }
  }
  window.addEventListener('message', async event => {
    if(event.source !== frame.contentWindow || event.data?.jsonrpc!=='2.0') return;
    const msg=event.data;
    state.requests.push({method:msg.method||'(response)',params:msg.params||null});
    if(msg.method==='ui/notifications/initialized') {
      state.initialized=true;
      send({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{path:initial}}});
      send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:browse({path:initial})});
      return;
    }
    if(msg.id===undefined || !msg.method) return;
    try { send({jsonrpc:'2.0',id:msg.id,result:await dispatch(msg.method,msg.params||{})}); }
    catch(error) { state.errors.push(String(error)); send({jsonrpc:'2.0',id:msg.id,error:{code:-32603,message:String(error)}}); }
  });
})();
