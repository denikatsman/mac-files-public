import fs from 'node:fs/promises';
import fsConstants from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const MAX_CHUNK = 256 * 1024;
const MAX_PREVIEW = 128 * 1024;
const CONTENT_PREFIX = 128 * 1024;
const MAX_VISITED = 10000;
const SEARCH_MS = 3000;
const CURSOR_TTL_MS = 5 * 60 * 1000;
const MAX_CURSORS = 64;
const MIME = {'.md':'text/markdown','.txt':'text/plain','.json':'application/json','.csv':'text/csv','.html':'text/html','.css':'text/css','.js':'text/javascript','.ts':'text/plain','.py':'text/plain','.swift':'text/plain','.sh':'text/plain','.yaml':'text/plain','.yml':'text/plain','.xml':'application/xml','.pdf':'application/pdf','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.mp4':'video/mp4','.mov':'video/quicktime','.zip':'application/zip'};
const mime = p => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
const kind = s => s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other';
const within = (root,p) => root === path.parse(root).root || p === root || p.startsWith(root + path.sep);
const version = s => crypto.createHash('sha256').update([s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':')).digest('hex');

function details(p, s) {
  const k = kind(s);
  return {name:path.basename(p), path:p, kind:k, size:k === 'file' ? Number(s.size) : null,
    modified:s.mtime ? s.mtime.toISOString() : new Date(Number(s.mtimeMs)).toISOString()};
}

// This root is a convenience scope, not a sandbox against a malicious local
// process racing path replacement. Authentication is required before any
// non-loopback deployment. Root '/' intentionally reflects the user's request.
export async function makeFilesystem(configuredRoot = '/', {now:cursorNow=Date.now,cursorTtlMs=CURSOR_TTL_MS,searchNow=Date.now,maxVisited=MAX_VISITED,pageTimeMs=SEARCH_MS}={}) {
  const root = await fs.realpath(configuredRoot);
  const home = await fs.realpath(os.homedir());
  const initial = within(root, home) ? home : root;
  const cursors = new Map();
  async function resolve(raw = initial) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw.includes('\0')) throw new Error('An absolute path is required.');
    const real = await fs.realpath(raw);
    if (!within(root, real)) throw new Error('Path is outside the configured root.');
    return real;
  }
  async function openFile(raw) {
    const p = await resolve(raw);
    const fd = await fs.open(p, fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0));
    try {
      const s = await fd.stat({bigint:true});
      if (!s.isFile()) throw new Error('The selected path is not a regular file.');
      return {fd,p,s};
    } catch (e) { await fd.close(); throw e; }
  }
  async function browse({path:raw = initial,offset = 0,limit = 100} = {}) {
    const p = await resolve(raw);
    const list = await fs.readdir(p, {withFileTypes:true});
    list.sort((a,b) => a.name.localeCompare(b.name));
    const entries = [];
    for (const entry of list.slice(offset, offset + limit)) {
      const child = path.join(p,entry.name);
      try { entries.push(details(child,await fs.lstat(child))); }
      catch { entries.push({name:entry.name,path:child,kind:'other',size:null,modified:null}); }
    }
    return {path:p,home:initial,parent:p === root ? null : path.dirname(p),entries,next_offset:offset+limit < list.length ? offset+limit : null};
  }
  async function info({path:raw}) {
    const p = await resolve(raw);
    return {...details(p,await fs.lstat(p)),mime_type:mime(p)};
  }
  async function read({path:raw,max_bytes = 65536,offset=0,expected_version}) {
    const {fd,p,s} = await openFile(raw);
    try {
      const size=Number(s.size),v=version(s);
      if(offset>0 && !expected_version) throw new Error('expected_version is required after the first page.');
      if(expected_version && expected_version!==v) throw new Error('The file changed while reading; start again.');
      if(offset>size) throw new Error('Offset exceeds the file size.');
      const take=Math.min(max_bytes,MAX_PREVIEW,size-offset), buf=Buffer.alloc(take);
      const {bytesRead}=await fd.read(buf,0,take,offset);
      if(!bytesRead && offset<size) throw new Error('File could not be read to completion.');
      const after=await fd.stat({bigint:true});
      if (version(after)!==v) throw new Error('File changed while it was being read.');
      const bytes=buf.subarray(0,bytesRead), out={path:p,name:path.basename(p),size,mime_type:mime(p),kind:'binary',offset,bytes_read:bytesRead,next_offset:null,eof:offset+bytesRead>=size,truncated:offset+bytesRead<size,version:v};
      if (!bytes.includes(0)) {
        let decoded;
        try {decoded=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes,{stream:offset+bytesRead<size});} catch {}
        if(decoded!==undefined){
          const consumed=Buffer.byteLength(decoded,'utf8');
          if(!consumed && bytesRead && offset+bytesRead<size) throw new Error('max_bytes is too small for the next UTF-8 character.');
          const next=offset+consumed;
          out.content=decoded;out.kind='text';out.bytes_read=consumed;out.eof=next>=size;
          out.next_offset=out.eof?null:next;out.truncated=!out.eof;
        }
      }
      return out;
    } finally {await fd.close();}
  }
  async function chunk({path:raw,offset=0,length=MAX_CHUNK,expected_version}) {
    const {fd,p,s}=await openFile(raw);
    try {
      const v=version(s), size=Number(s.size);
      if (offset>0 && !expected_version) throw new Error('expected_version is required after the first chunk.');
      if (expected_version && v!==expected_version) throw new Error('The file changed during download; start again.');
      if (offset>size) throw new Error('Offset exceeds the file size.');
      const wanted=Math.min(length,MAX_CHUNK,size-offset), buffer=Buffer.alloc(wanted);
      const {bytesRead}=await fd.read(buffer,0,wanted,offset);
      const after=await fd.stat({bigint:true});
      if (version(after)!==v) throw new Error('The file changed during download; start again.');
      const next_offset=offset+bytesRead;
      return {payload:{path:p,name:path.basename(p),size,offset,length:bytesRead,next_offset,eof:next_offset>=size,mime_type:mime(p),version:v},data_base64:buffer.subarray(0,bytesRead).toString('base64')};
    } finally {await fd.close();}
  }
  async function snapshot({path:raw,max_bytes}) {
    const {fd,p,s}=await openFile(raw);
    try {
      const size=Number(s.size), v=version(s);
      if(size<1 || size>max_bytes) throw new Error('File is empty or exceeds the preview limit.');
      const buffer=Buffer.alloc(size);let offset=0;
      while(offset<size){const {bytesRead}=await fd.read(buffer,offset,size-offset,offset);if(!bytesRead)throw new Error('File could not be read to completion.');offset+=bytesRead;}
      if(version(await fd.stat({bigint:true}))!==v) throw new Error('File changed while it was being read.');
      return {path:p,name:path.basename(p),bytes:buffer,version:v};
    } finally {await fd.close();}
  }
  async function search(args) {
    const previous=args.cursor ? cursors.get(args.cursor) : null;
    if(previous){
      const start=await resolve(args.root || initial);
      if(previous.root!==start || previous.query!==args.query || previous.mode!==(args.mode || 'name') || previous.limit!==(args.limit ?? 50)) throw new Error('Search cursor does not match the requested search.');
      if(previous.running) return previous.running;
      if(cursorNow()-previous.touched>cursorTtlMs){cursors.delete(args.cursor);return searchPage(args);}
    }
    const running=searchPage(args);
    if(previous) previous.running=running;
    try{return await running;}finally{if(previous) previous.running=null;}
  }
  async function searchPage({root:raw=initial,query,mode='name',limit=50,cursor}) {
    const start=await resolve(raw), needle=query.toLocaleLowerCase(), now=cursorNow();
    for (const [id,item] of cursors) if (now-item.touched>cursorTtlMs && !item.running) cursors.delete(id);
    let state,previous;
    if (cursor) {
      previous=cursors.get(cursor);
      if (!previous) throw new Error('Search cursor expired or is invalid; start a new search.');
      if(previous.root!==start || previous.query!==query || previous.mode!==mode || previous.limit!==limit) throw new Error('Search cursor does not match the requested search.');
      previous.touched=now;
      if(previous.response) return previous.response;
      state=previous.state;
    } else {
      if (!(await fs.stat(start)).isDirectory()) throw new Error('Search root is not a directory.');
      state={queue:[start],pending:null,pending_file:null};
    }
    const entries=[], began=searchNow();
    let scanned=0,errors=0,skipped_symlinks=0,skipped_binary=0,bytes_scanned=0;
    while(entries.length<limit && scanned<maxVisited && searchNow()-began<=pageTimeMs) {
      if(state.pending_file){
        const current=state.pending_file; let fd;
        try {
          fd=await fs.open(current.path,fsConstants.constants.O_RDONLY | (fsConstants.constants.O_NOFOLLOW || 0));
          const stat=await fd.stat({bigint:true});
          if(!stat.isFile()) throw new Error('File is no longer regular.');
          const v=version(stat), size=Number(stat.size);
          if(current.version && current.version!==v) throw new Error('File changed while searching.');
          if(!current.version) current.version=v;
          const n=Math.min(CONTENT_PREFIX,size-current.offset), b=Buffer.alloc(n);
          const {bytesRead}=await fd.read(b,0,n,current.offset), data=b.subarray(0,bytesRead);
          const after=await fd.stat({bigint:true});
          if(version(after)!==v) throw new Error('File changed while searching.');
          if(!bytesRead && current.offset<size) throw new Error('File could not be read to completion.');
          bytes_scanned+=bytesRead;current.offset+=bytesRead;
          if(data.includes(0)){skipped_binary++;state.pending_file=null;continue;}
          let text;
          try {text=current.decoder.decode(data,{stream:current.offset<size});}
          catch {skipped_binary++;state.pending_file=null;continue;}
          const combined=current.carry+text, i=combined.toLocaleLowerCase().indexOf(needle);
          if(i>=0){
            const entry=details(current.path,await fs.lstat(current.path));
            entry.snippet=combined.slice(Math.max(0,i-80),Math.min(combined.length,i+query.length+80));
            entries.push(entry);state.pending_file=null;
          } else if(current.offset>=size){state.pending_file=null;}
          else {current.carry=combined.slice(-Math.max(query.length*2,256));}
        } catch {errors++;state.pending_file=null;} finally {if(fd) await fd.close();}
        continue;
      }
      if(!state.pending || state.pending.index>=state.pending.children.length){
        state.pending=null;
        if(!state.queue.length) break;
        const directory=state.queue.pop();
        try {const children=await fs.readdir(directory,{withFileTypes:true});children.sort((a,b)=>a.name.localeCompare(b.name));state.pending={directory,children,index:0};}
        catch {errors++;continue;}
        if(!state.pending.children.length) continue;
      }
      const child=state.pending.children[state.pending.index++], p=path.join(state.pending.directory,child.name);
      scanned++;
      if(child.isSymbolicLink()) skipped_symlinks++;
      if(child.isDirectory()) state.queue.push(p);
      const hit=mode==='name' && child.name.toLocaleLowerCase().includes(needle);
      if(mode==='content' && child.isFile()) state.pending_file={path:p,offset:0,version:null,decoder:new TextDecoder('utf-8',{fatal:true}),carry:''};
      if(hit) { try {entries.push(details(p,await fs.lstat(p)));} catch {errors++;} }
    }
    const more=Boolean(state.pending_file) || state.queue.length>0 || Boolean(state.pending && state.pending.index<state.pending.children.length);
    let next_cursor=null;
    if(more){
      next_cursor=crypto.randomBytes(24).toString('base64url');
      cursors.set(next_cursor,{root:start,query,mode,limit,state,touched:cursorNow()});
    }
    const output={root:start,query,mode,entries,scanned,truncated:more || !!skipped_binary || !!errors || !!skipped_symlinks,errors,partial_files:state.pending_file?1:0,skipped_symlinks,skipped_binary,bytes_scanned,content_chunk_bytes:CONTENT_PREFIX,next_cursor};
    if(previous){previous.state=null;previous.response=output;previous.touched=cursorNow();}
    while(cursors.size>MAX_CURSORS){const first=cursors.keys().next().value;cursors.delete(first);}
    return output;
  }
  return {root,initial,browse,info,read,chunk,snapshot,search};
}
