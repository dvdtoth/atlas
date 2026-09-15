import { tileMipLevels } from './text-detail.mjs';
import { AdaptiveTextBudget } from './text-budget.mjs';
import { basis } from './core.mjs';
const cameraCode = `
diagnostic(off, derivative_uniformity);
struct Camera {hi:vec4f,lo:vec4f,right:vec4f,up:vec4f,forward:vec4f,viewport:vec4f,planes:vec4f};
@group(0) @binding(0) var<uniform> c:Camera;
struct Shape {hi:vec4f,lo:vec4f,v:vec4f,tint:vec4f,info:vec4u,shape:vec4f};
fn fileFill(tint:vec3f,selected:u32,flight:bool)->vec3f{
 var fill=tint*0.105+vec3f(0.012,0.019,0.024);
 if(selected>0u){fill+=vec3f(0.07,0.045,0.005);}
 return fill*select(1.0,0.8,flight);
}
fn relative(g:Shape)->vec3f{return (g.hi.xyz-c.hi.xyz)+(g.lo.xyz-c.lo.xyz);}
fn clip(p:vec3f)->vec4f {
 if(c.viewport.w<0.5){return vec4f(p.x*c.viewport.z*2.0/c.viewport.x,-p.y*c.viewport.z*2.0/c.viewport.y,0.5,1.0);}
 let z=dot(p,c.forward.xyz);let n=c.planes.x;let f=c.planes.y;
 return vec4f(dot(p,c.right.xyz)/(0.70020754*c.viewport.x/c.viewport.y),dot(p,c.up.xyz)/0.70020754,n*f/(f-n)-z*n/(f-n),z);
}
`;
const cullCode =
  cameraCode +
  `
@group(0) @binding(1) var<storage,read> shapes:array<Shape>;
@group(0) @binding(3) var<storage,read_write> visible:array<u32>;
struct Args {vertices:u32,count:atomic<u32>,first:u32,instance:u32};
@group(0) @binding(4) var<storage,read_write> args:Args;
@compute @workgroup_size(128) fn cull(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=arrayLength(&shapes)){return;}let g=shapes[i];let p=relative(g);var show=false;
 if(c.viewport.w<0.5){let halfSize=c.viewport.xy/(2.0*c.viewport.z);show=p.x<halfSize.x&&p.x+g.hi.w > -halfSize.x&&p.y<halfSize.y&&p.y+g.v.w > -halfSize.y&&max(g.hi.w,g.v.w)*c.viewport.z>0.08;}
 else{let mid=p+vec3f(g.hi.w,g.v.x,g.v.y)*0.5;let radius=length(vec3f(g.hi.w,g.v.x,g.v.y))*0.5;let z=dot(mid,c.forward.xyz);let h=z*0.70020754;show=z+radius>c.planes.x&&z-radius<c.planes.y&&abs(dot(mid,c.up.xyz))<h+radius*1.23&&abs(dot(mid,c.right.xyz))<h*c.viewport.x/c.viewport.y+radius*1.9;}
 if(show){let slot=atomicAdd(&args.count,1u);visible[slot]=i;}
}`;
const renderCode =
  cameraCode +
  `
@group(0) @binding(1) var<storage,read> shapes:array<Shape>;
@group(0) @binding(2) var<storage,read> profiles:array<u32>;
@group(0) @binding(3) var<storage,read> visible:array<u32>;
@group(0) @binding(5) var<storage,read> highlights:array<u32>;
struct Out {@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) @interpolate(flat) index:u32};
@vertex fn vs(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Out{
 let corners=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));let uv=corners[vertex];let i=visible[instance];let g=shapes[i];var p=relative(g);
 if(c.viewport.w<0.5){p+=vec3f(uv.x*g.hi.w,uv.y*g.v.w,0);}else{p+=vec3f(uv.x*g.hi.w,uv.y*g.v.x,uv.y*g.v.y);}
 var out:Out;out.position=clip(p);out.uv=uv;if(c.viewport.w>0.5){if(dot(vec3f(g.hi.w,0,0),c.right.xyz)<0){out.uv.x=1.0-uv.x;}if(dot(vec3f(0,g.v.x,g.v.y),c.up.xyz)>0){out.uv.y=1.0-uv.y;}}out.index=i;return out;
}
fn inkAt(row:f32,cols:f32,total:f32,offset:u32)->f32{
 let sample=min(15u,u32(clamp(row/max(1.0,total),0.0,0.99999)*16.0));
 let packed=profiles[min(arrayLength(&profiles)-1u,offset+sample)];let left=f32(packed&65535u);let right=left+f32(packed>>16u);
 let dx=max(0.3,fwidth(cols));let dy=max(0.01,fwidth(row));
 let horizontal=smoothstep(left-dx,left+dx,cols)*(1.0-smoothstep(right-dx,right+dx,cols));
 let line=1.0-smoothstep(0.12,0.46,abs(fract(row)-0.5));
 let filtered=mix(line,0.34,smoothstep(0.5,1.8,dy));
 return select(horizontal*filtered,0.0,right<=left);
}
@fragment fn fs(in:Out)->@location(0) vec4f{
 let g=shapes[in.index];let selected=highlights[g.info.x];let d=max(fwidth(in.uv),vec2f(1e-9));let edge=min(min(in.uv.x/d.x,(1.0-in.uv.x)/d.x),min(in.uv.y/d.y,(1.0-in.uv.y)/d.y));
 if(c.viewport.w>0.5&&g.shape.y>0.5){if(edge>1.0){discard;}return vec4f(vec3f(.15,.34,.37)*mix(.25,1.0,smoothstep(1.0,50.0,1.0/max(d.x,d.y))),1.0);}
 var border=g.tint.rgb;var stroke=0.52;var fill=fileFill(g.tint.rgb,selected,c.viewport.w>0.5);var ink=0.0;
 if(selected>0u){border=vec3f(1.0,0.77,0.22);stroke=select(1.6,2.5,selected==2u);}
 if(c.viewport.w<0.5){
  let h=g.v.x;let pw=g.v.y;let panels=max(1u,g.info.w);let xy=in.uv*vec2f(g.hi.w,g.v.w);let panel=min(panels-1u,u32(max(0.0,floor(xy.x/(pw+2.0*h)))));
  let rows=max(1u,g.info.z);let q=rows/panels;let rem=rows%panels;let count=q+select(0u,1u,panel<rem);
  let row=(xy.y-select(4.0,2.0,panels==1u)*h)/h;let x=(xy.x-f32(panel)*(pw+2.0*h)-h)/(h*0.45);
  if(row>=0.0&&row<f32(count)&&x>=0.0&&x<g.v.z&&g.info.z>0u){ink=inkAt(row,x,f32(count),g.info.y+panel*16u);}
  let gap=abs(xy.x-(f32(panel)*(pw+2.0*h)));if(panel>0u&&gap<h*0.28){fill+=g.tint.rgb*0.12;}
 }else{let row=f32(g.info.z)+in.uv.y*f32(g.info.w);ink=inkAt(row,in.uv.x*g.v.w,g.shape.x,g.info.y);}
 let paper=vec3f(0.49,0.60,0.63)+g.tint.rgb*0.12;let colour=fill+paper*ink*0.82;if(selected==0u&&c.viewport.w<0.5){border*=mix(0.20,1.0,smoothstep(1.0,7.0,1.0/max(d.x,d.y)));}
 return vec4f(mix(colour,border,1.0-smoothstep(stroke,stroke+0.7,edge)),1.0);
}`;
const textCode =
  cameraCode +
  `
struct Tile {origin:vec4f,across:vec4f,down:vec4f,uv:vec4f,options:vec4f};
@group(0) @binding(1) var<storage,read> highlights:array<u32>;
@group(1) @binding(0) var<uniform> t:Tile;
@group(1) @binding(1) var tex:texture_2d<f32>;
@group(1) @binding(2) var samp:sampler;
struct Out {@builtin(position) position:vec4f,@location(0) uv:vec2f};
@vertex fn tvs(@builtin(vertex_index) i:u32)->Out{
 let p=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[i];var out:Out;
 out.position=clip(t.origin.xyz+t.across.xyz*p.x+t.down.xyz*p.y);out.uv=t.uv.xy+p*t.uv.zw;
 if(c.viewport.w>0.5){out.position.z*=1.0003;}
 return out;
}
@fragment fn tfs(in:Out)->@location(0) vec4f{
 let v=textureSample(tex,samp,in.uv);let color=u32(t.options.z);
 let tint=vec3f(f32(color&255u),f32((color>>8u)&255u),f32((color>>16u)&255u))/255.0;
 let fill=fileFill(tint,highlights[u32(t.options.y)],c.viewport.w>0.5);
 // Premultiplied ink over an opaque live file background also hides coarse
 // preview bars. Filtering the ink and its coverage together avoids dark halos.
 return vec4f(v.rgb+fill*(1.0-v.a),t.options.x);
}
`;
const selectionCode =
  cameraCode +
  `
struct Selection {origin:vec4f,across:vec4f,down:vec4f};
@group(1) @binding(0) var<uniform> s:Selection;
struct SelectionOut {@builtin(position) position:vec4f,@location(0) uv:vec2f};
@vertex fn svs(@builtin(vertex_index) i:u32)->SelectionOut{
 let uv=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[i];
 var out:SelectionOut;out.position=clip(s.origin.xyz+s.across.xyz*uv.x+s.down.xyz*uv.y);out.uv=uv;
 if(c.viewport.w>0.5){out.position.z*=1.0006;}return out;
}
@fragment fn sfs(in:SelectionOut)->@location(0) vec4f{
 let d=max(fwidth(in.uv),vec2f(1e-9));let edge=min(min(in.uv.x/d.x,(1.0-in.uv.x)/d.x),min(in.uv.y/d.y,(1.0-in.uv.y)/d.y));
 return vec4f(1.0,0.77,0.22,0.24+0.6*(1.0-smoothstep(1.0,1.7,edge)));
}`;
const MAX_SELECTION_PLANES = 128;
export class GPUView {
  async init(canvas, previews, nodeCount, onError) {
    if (!navigator.gpu)
      throw Error(
        'WebGPU is unavailable. Open this experiment in current Chrome, Edge or Safari on a supported GPU.',
      );
    this.canvas = canvas;
    this.onError = onError;
    this.adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!this.adapter) throw Error('No WebGPU adapter was available.');
    this.device = await this.adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.max(128 * 1024 * 1024, previews.byteLength),
      },
    });
    const d = this.device;
    this.textBudget = new AdaptiveTextBudget({
      deviceMemory: navigator.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
      fallback: this.adapter.isFallbackAdapter === true,
      maxBufferSize: d.limits.maxBufferSize,
    });
    this.maxTextDraws = this.textBudget.capacity;
    d.addEventListener('uncapturederror', (e) => onError(e.error.message));
    d.lost.then((x) => onError(`GPU device lost: ${x.message}. Reload to recover.`));
    this.context = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: d, format: this.format, alphaMode: 'opaque' });
    this.camera = d.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.profiles = this.buffer(previews, GPUBufferUsage.STORAGE);
    this.highlights = d.createBuffer({
      size: Math.max(4, nodeCount * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    for (const [name, code] of [
      ['cull', cullCode],
      ['render', renderCode],
      ['text', textCode],
      ['selection', selectionCode],
    ]) {
      const info = await d.createShaderModule({ code }).getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length)
        throw Error(
          name + ': ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n'),
        );
    }
    this.cull = d.createComputePipeline({
      layout: 'auto',
      compute: { module: d.createShaderModule({ code: cullCode }), entryPoint: 'cull' },
    });
    const mod = d.createShaderModule({ code: renderCode });
    const desc = {
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs' },
      fragment: { module: mod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      multisample: { count: 4 },
    };
    this.flat = d.createRenderPipeline(desc);
    this.flight = d.createRenderPipeline({
      ...desc,
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const tileLayout = d.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 80 },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const camLayout = d.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: 128 },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.textLayout = tileLayout;
    this.textCamera = d.createBindGroup({
      layout: camLayout,
      entries: [
        { binding: 0, resource: { buffer: this.camera } },
        { binding: 1, resource: { buffer: this.highlights } },
      ],
    });
    this.tileBuffer = d.createBuffer({
      size: 256 * this.maxTextDraws,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.sampler = d.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 4,
    });
    const tm = d.createShaderModule({ code: textCode });
    const td = {
      layout: d.createPipelineLayout({ bindGroupLayouts: [camLayout, tileLayout] }),
      vertex: { module: tm, entryPoint: 'tvs' },
      fragment: {
        module: tm,
        entryPoint: 'tfs',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        ],
      },
      multisample: { count: 4 },
    };
    this.textFlat = d.createRenderPipeline(td);
    this.textFlight = d.createRenderPipeline({
      ...td,
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
    });
    const selectionLayout = d.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 },
        },
      ],
    });
    this.selectionBuffer = d.createBuffer({
      size: 256 * MAX_SELECTION_PLANES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.selectionBind = d.createBindGroup({
      layout: selectionLayout,
      entries: [{ binding: 0, resource: { buffer: this.selectionBuffer, size: 48 } }],
    });
    const sm = d.createShaderModule({ code: selectionCode }),
      sd = {
        ...td,
        layout: d.createPipelineLayout({ bindGroupLayouts: [camLayout, selectionLayout] }),
        vertex: { module: sm, entryPoint: 'svs' },
        fragment: { module: sm, entryPoint: 'sfs', targets: td.fragment.targets },
      };
    this.selectionFlat = d.createRenderPipeline(sd);
    this.selectionFlight = d.createRenderPipeline({
      ...sd,
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
    });
    const mipShader = d.createShaderModule({
      code: `
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var imageSampler:sampler;
struct MipVertex {@builtin(position) position:vec4f,@location(0) uv:vec2f};
@vertex fn vs(@builtin(vertex_index) i:u32)->MipVertex {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];
 var v:MipVertex;v.position=vec4f(p,0,1);v.uv=vec2f((p.x+1)*.5,(1-p.y)*.5);return v;
}
@fragment fn fs(v:MipVertex)->@location(0) vec4f{return textureSample(image,imageSampler,v.uv);}`,
    });
    this.mipPipeline = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module: mipShader, entryPoint: 'vs' },
      fragment: { module: mipShader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
    this.mipSampler = d.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.previousHighlights = [];
    this.packs2 = [];
    this.packs3 = [];
    this.frame = 0;
    return this;
  }
  buffer(data, usage) {
    const b = this.device.createBuffer({
      size: Math.max(4, data.byteLength),
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(b, 0, data);
    return b;
  }
  pack(data) {
    const d = this.device,
      b = this.buffer(data, GPUBufferUsage.STORAGE),
      count = data.byteLength / 96,
      visible = d.createBuffer({ size: Math.max(4, count * 4), usage: GPUBufferUsage.STORAGE }),
      args = d.createBuffer({
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
      });
    const bind = (pipeline, entries) =>
      d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
      });
    const renderEntries = [
      [0, this.camera],
      [1, b],
      [2, this.profiles],
      [3, visible],
      [5, this.highlights],
    ];
    return {
      b,
      visible,
      args,
      count,
      compute: bind(this.cull, [
        [0, this.camera],
        [1, b],
        [3, visible],
        [4, args],
      ]),
      flat: bind(this.flat, renderEntries),
      flight: bind(this.flight, renderEntries),
    };
  }
  load(map, flights) {
    this.packs2 = [this.pack(map)];
    this.packs3 = flights.map((x) => this.pack(x));
  }
  highlight(indices, selected) {
    const now = new Set(indices);
    if (selected >= 0) now.add(selected);
    for (const i of this.previousHighlights)
      if (!now.has(i)) this.device.queue.writeBuffer(this.highlights, i * 4, new Uint32Array([0]));
    for (const i of now)
      this.device.queue.writeBuffer(
        this.highlights,
        i * 4,
        new Uint32Array([i === selected ? 2 : 1]),
      );
    this.previousHighlights = [...now];
  }
  resize(w, h) {
    if (this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.depth?.destroy();
    this.msaa?.destroy();
    this.depth = this.device.createTexture({
      size: [w, h],
      format: 'depth32float',
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.msaa = this.device.createTexture({
      size: [w, h],
      format: this.format,
      sampleCount: 4,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }
  uploadTile(bitmap, { mipmapped = false } = {}) {
    const d = this.device,
      levels = mipmapped ? tileMipLevels(bitmap.height / (32 * 20)) : 1;
    const texture = d.createTexture({
      size: [bitmap.width, bitmap.height],
      mipLevelCount: levels,
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    d.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: true }, [
      bitmap.width,
      bitmap.height,
    ]);
    let bytes = bitmap.width * bitmap.height * 4,
      width = bitmap.width,
      height = bitmap.height;
    if (levels > 1) {
      const encoder = d.createCommandEncoder();
      for (let level = 1; level < levels; level++) {
        width = Math.max(1, Math.floor(width / 2));
        height = Math.max(1, Math.floor(height / 2));
        bytes += width * height * 4;
        const bind = d.createBindGroup({
          layout: this.mipPipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }),
            },
            { binding: 1, resource: this.mipSampler },
          ],
        });
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
              loadOp: 'clear',
              clearValue: [0, 0, 0, 1],
              storeOp: 'store',
            },
          ],
        });
        pass.setPipeline(this.mipPipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
      }
      d.queue.submit([encoder.finish()]);
    }
    const bind = d.createBindGroup({
      layout: this.textLayout,
      entries: [
        { binding: 0, resource: { buffer: this.tileBuffer, offset: 0, size: 80 } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: this.sampler },
      ],
    });
    return { texture, bind, bytes };
  }
  render(view, tiles = [], selection = []) {
    const d = this.device,
      mode = view.mode === '3d',
      cam = view.cam,
      b = mode
        ? basis(cam.yaw, cam.pitch)
        : { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] },
      eye = mode ? cam.eye : [cam.x, cam.y, 0];
    const u = new Float32Array(32);
    for (let i = 0; i < 3; i++) {
      u[i] = eye[i];
      u[4 + i] = eye[i] - u[i];
    }
    u.set(b.right, 8);
    u.set(b.up, 12);
    u.set(b.forward, 16);
    u.set([this.w, this.h, mode ? 1 : cam.scale * view.dpr, mode ? 1 : 0], 20);
    u.set(
      [Math.max(1e-8, (view.speed || 1) / 5000), view.far || 2e6, performance.now() / 1000, 0],
      24,
    );
    d.queue.writeBuffer(this.camera, 0, u);
    const packs = mode ? this.packs3 : this.packs2;
    for (const p of packs) d.queue.writeBuffer(p.args, 0, new Uint32Array([6, 0, 0, 0]));
    const encodedTiles = new Float32Array(Math.min(this.maxTextDraws, tiles.length) * 64);
    for (let i = 0; i < Math.min(this.maxTextDraws, tiles.length); i++) {
      const t = tiles[i],
        o = i * 64;
      encodedTiles.set(
        t.origin.map((x, j) => x - eye[j]),
        o,
      );
      encodedTiles.set(t.across, o + 4);
      encodedTiles.set(t.down, o + 8);
      encodedTiles.set(t.uv || [0, 0, 1, 1], o + 12);
      encodedTiles[o + 16] = t.opacity ?? 1;
      encodedTiles[o + 17] = t.node;
      encodedTiles[o + 18] = t.color & 0xffffff;
    }
    if (encodedTiles.length) d.queue.writeBuffer(this.tileBuffer, 0, encodedTiles);
    const selectionCount = Math.min(MAX_SELECTION_PLANES, selection.length),
      selectedPlanes = new Float32Array(selectionCount * 64);
    for (let i = 0; i < selectionCount; i++) {
      const p = selection[i],
        o = i * 64;
      selectedPlanes.set(
        p.origin.map((x, j) => x - eye[j]),
        o,
      );
      selectedPlanes.set(p.across, o + 4);
      selectedPlanes.set(p.down, o + 8);
    }
    if (selectionCount) d.queue.writeBuffer(this.selectionBuffer, 0, selectedPlanes);
    const enc = d.createCommandEncoder(),
      cp = enc.beginComputePass();
    cp.setPipeline(this.cull);
    for (const p of packs) {
      cp.setBindGroup(0, p.compute);
      cp.dispatchWorkgroups(Math.ceil(p.count / 128));
    }
    cp.end();
    const target = this.context.getCurrentTexture().createView();
    const desc = {
      colorAttachments: [
        {
          view: this.msaa.createView(),
          resolveTarget: target,
          clearValue: { r: 0.012, g: 0.018, b: 0.026, a: 1 },
          loadOp: 'clear',
          storeOp: 'discard',
        },
      ],
    };
    if (mode)
      desc.depthStencilAttachment = {
        view: this.depth.createView(),
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      };
    const rp = enc.beginRenderPass(desc);
    rp.setPipeline(mode ? this.flight : this.flat);
    for (const p of packs) {
      rp.setBindGroup(0, mode ? p.flight : p.flat);
      rp.drawIndirect(p.args, 0);
    }
    if (tiles.length) {
      rp.setPipeline(mode ? this.textFlight : this.textFlat);
      rp.setBindGroup(0, this.textCamera);
      for (let i = 0; i < Math.min(this.maxTextDraws, tiles.length); i++) {
        rp.setBindGroup(1, tiles[i].tile.bind, [i * 256]);
        rp.draw(6);
      }
    }
    // Draw after glyphs so arriving text tiles never erase the selected range.
    // Flight uses the scene depth buffer so unrelated sheets still occlude it.
    if (selectionCount) {
      rp.setPipeline(mode ? this.selectionFlight : this.selectionFlat);
      rp.setBindGroup(0, this.textCamera);
      for (let i = 0; i < selectionCount; i++) {
        rp.setBindGroup(1, this.selectionBind, [i * 256]);
        rp.draw(6);
      }
    }
    rp.end();
    d.queue.submit([enc.finish()]);
    this.frame++;
  }
}
