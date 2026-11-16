/* tga-js 1.1.1 (npm package "tga-js", dist/esm/tga.js)
 * Source: https://github.com/vthibault/tga.js  (https://registry.npmjs.org/tga-js/-/tga-js-1.1.1.tgz)
 * Vendored for Slate from esm.sh (https://esm.sh/tga-js@1.1.1), unedited below this header.
 *
 * Licence: MIT
 *
 * Copyright (c) 2013-2020 Vincent Thibault, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE. */
var m=class{_checkHeader(){let t=this.header;if(t.imageType===0)throw Error("No data");if(t.hasColorMap){if(t.colorMapLength>256||t.colorMapDepth!==24||t.colorMapType!==1)throw Error("Invalid colormap for indexed type")}else if(t.colorMapType)throw Error("Why does the image contain a palette ?");if(!t.width||!t.height)throw Error("Invalid image size");if(t.pixelDepth!==8&&t.pixelDepth!==16&&t.pixelDepth!==24&&t.pixelDepth!==32)throw Error('Invalid pixel size "'+t.pixelDepth+'"')}_decodeRLE(t,a,e,r){let n=new Uint8Array(r),p=new Uint8Array(e),l=0;for(;l<r;){let c=t[a++],g=1+(127&c);if(128&c){for(let s=0;s<e;++s)p[s]=t[a+s];a+=e;for(let s=0;s<g;++s)n.set(p,l),l+=e}else{g*=e;for(let s=0;s<g;++s)n[l+s]=t[a+s];l+=g,a+=g}}return n}_getImageData8bits(t,a,e,r,n,p,l,c,g,s){for(let h=0,o=n;o!==l;o+=p)for(let i=c;i!==s;i+=g,h++){let d=a[h];t[4*(i+r*o)+3]=255,t[4*(i+r*o)+2]=e[3*d+0],t[4*(i+r*o)+1]=e[3*d+1],t[4*(i+r*o)+0]=e[3*d+2]}return t}_getImageData16bits(t,a,e,r,n,p,l,c,g,s){for(let h=0,o=n;o!==l;o+=p)for(let i=c;i!==s;i+=g,h+=2){let d=a[h+0]|a[h+1]<<8;t[4*(i+r*o)+0]=(31744&d)>>7,t[4*(i+r*o)+1]=(992&d)>>2,t[4*(i+r*o)+2]=(31&d)>>3,t[4*(i+r*o)+3]=32768&d?0:255}return t}_getImageData24bits(t,a,e,r,n,p,l,c,g,s){for(let h=0,o=n;o!==l;o+=p)for(let i=c;i!==s;i+=g,h+=3)t[4*(i+r*o)+3]=255,t[4*(i+r*o)+2]=a[h+0],t[4*(i+r*o)+1]=a[h+1],t[4*(i+r*o)+0]=a[h+2];return t}_getImageData32bits(t,a,e,r,n,p,l,c,g,s){for(let h=0,o=n;o!==l;o+=p)for(let i=c;i!==s;i+=g,h+=4)t[4*(i+r*o)+2]=a[h+0],t[4*(i+r*o)+1]=a[h+1],t[4*(i+r*o)+0]=a[h+2],t[4*(i+r*o)+3]=a[h+3];return t}_getImageDataGrey8bits(t,a,e,r,n,p,l,c,g,s){for(let h=0,o=n;o!==l;o+=p)for(let i=c;i!==s;i+=g,h++){let d=a[h];t[4*(i+r*o)+0]=d,t[4*(i+r*o)+1]=d,t[4*(i+r*o)+2]=d,t[4*(i+r*o)+3]=255}return t}_getImageDataGrey16bits(t,a,e,r,n,p,l,c,g,s){for(let h=0,o=n;o!==l;o+=p)for(let i=c;i!==s;i+=g,h+=2)t[4*(i+r*o)+0]=a[h+0],t[4*(i+r*o)+1]=a[h+0],t[4*(i+r*o)+2]=a[h+0],t[4*(i+r*o)+3]=a[h+1];return t}open(t,a){let e=new XMLHttpRequest;e.responseType="arraybuffer",e.open("GET",t,!0),e.onload=(()=>{e.status===200&&(this.load(new Uint8Array(e.response)),a&&a())}),e.send(null)}load(t){let a=0;if(t.length<18)throw Error("Not enough data to contain header");let e={idLength:t[a++],colorMapType:t[a++],imageType:t[a++],colorMapIndex:t[a++]|t[a++]<<8,colorMapLength:t[a++]|t[a++]<<8,colorMapDepth:t[a++],offsetX:t[a++]|t[a++]<<8,offsetY:t[a++]|t[a++]<<8,width:t[a++]|t[a++]<<8,height:t[a++]|t[a++]<<8,pixelDepth:t[a++],flags:t[a++]};if(e.hasEncoding=e.imageType===9||e.imageType===10||e.imageType===11,e.hasColorMap=e.imageType===9||e.imageType===1,e.isGreyColor=e.imageType===11||e.imageType===3,this.header=e,this._checkHeader(),(a+=e.idLength)>=t.length)throw Error("No data");if(e.hasColorMap){let l=e.colorMapLength*(e.colorMapDepth>>3);this.palette=t.subarray(a,a+l),a+=l}let r=e.pixelDepth>>3,n=e.width*e.height,p=n*r;e.hasEncoding?this.imageData=this._decodeRLE(t,a,r,p):this.imageData=t.subarray(a,a+(e.hasColorMap?n:p))}getImageData(t){let{width:a,height:e,flags:r,pixelDepth:n,isGreyColor:p}=this.header,l=(r&48)>>4,c,g,s,h,o,i,d;switch(t||(t=document?document.createElement("canvas").getContext("2d").createImageData(a,e):{width:a,height:e,data:new Uint8ClampedArray(a*e*4)}),l===2||l===3?(h=0,o=1,i=e):(h=e-1,o=-1,i=-1),l===2||l===0?(c=0,g=1,s=a):(c=a-1,g=-1,s=-1),n){case 8:d=p?this._getImageDataGrey8bits:this._getImageData8bits;break;case 16:d=p?this._getImageDataGrey16bits:this._getImageData16bits;break;case 24:d=this._getImageData24bits;break;case 32:d=this._getImageData32bits}return d.call(this,t.data,this.imageData,this.palette,a,h,o,i,c,g,s),t}getCanvas(){let{width:t,height:a}=this.header,e=document.createElement("canvas"),r=e.getContext("2d"),n=r.createImageData(t,a);return e.width=t,e.height=a,r.putImageData(this.getImageData(n),0,0),e}getDataURL(t){return this.getCanvas().toDataURL(t||"image/png")}};export{m as default};
/*! Bundled license information:

tga-js/dist/esm/tga.js:
  (**
   * @license tga-js 1.1.1
   * Copyright (c) 2013-2020 Vincent Thibault, Inc.
   * License: MIT
   *)
*/
//# sourceMappingURL=tga-js.mjs.map