/* dds-parser 1.0.1 (npm package "dds-parser", dist/es/dds-parser.js)
 * Source: https://github.com/4eb0da/dds-parser  (https://registry.npmjs.org/dds-parser/-/dds-parser-1.0.1.tgz)
 * Vendored for Slate from esm.sh (https://esm.sh/dds-parser@1.0.1), unedited below this header.
 *
 * Licence: MIT
 *
 * MIT License
 *
 * Copyright (c) 2017-2023 4eb0da
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE. */
var J=542327876,K=131072,Q=4,V=H("DXT1"),Z=H("DXT3"),$=H("DXT5"),t=H("ATI2"),w=31,W=0,O=1,p=2,X=3,I=4,Y=7,s=20,h=21;function vr(r){var a=new Int32Array(r,0,w);if(a[W]!==J)throw new Error("Invalid magic number in DDS header");if(!(a[s]&Q))throw new Error("Unsupported format, must contain a FourCC code");var v,e,A=a[h];switch(A){case V:v=8,e="dxt1";break;case Z:v=16,e="dxt3";break;case $:v=16,e="dxt5";break;case t:v=16,e="ati2";break;default:throw new Error("Unsupported FourCC code: "+b(A))}var C=a[p],D=1;C&K&&(D=Math.max(1,a[Y]));for(var f=a[I],n=a[X],x=a[O]+4,F=f,g=n,_=[],d,y=0;y<D;y++)d=Math.max(4,f)/4*Math.max(4,n)/4*v,_.push({offset:x,length:d,shape:{width:f,height:n}}),x+=d,f=Math.floor(f/2),n=Math.floor(n/2);return{shape:{width:F,height:g},images:_,format:e,flags:C}}function H(r){return r.charCodeAt(0)+(r.charCodeAt(1)<<8)+(r.charCodeAt(2)<<16)+(r.charCodeAt(3)<<24)}function b(r){return String.fromCharCode(r&255,r>>8&255,r>>16&255,r>>24&255)}function L(r,a){return((1<<a)-1)/((1<<r)-1)}var k=L(4,8),R=L(5,8),P=L(6,8),S=new Uint8Array(16),i=new Uint8Array(12),m=new Uint8Array(8),z=new Uint8Array(8),G=new Uint8Array(8);function u(r,a,v){var e=(a>>11&31)*R,A=(a>>5&63)*P,C=(a&31)*R,D=(v>>11&31)*R,f=(v>>5&63)*P,n=(v&31)*R;r[0]=e,r[1]=A,r[2]=C,r[3]=255,r[4]=D,r[5]=f,r[6]=n,r[7]=255,a>v?(r[8]=5*e+3*D>>3,r[9]=5*A+3*f>>3,r[10]=5*C+3*n>>3,r[11]=255,r[12]=5*D+3*e>>3,r[13]=5*f+3*A>>3,r[14]=5*n+3*C>>3,r[15]=255):(r[8]=e+D>>1,r[9]=A+f>>1,r[10]=C+n>>1,r[11]=255,r[12]=0,r[13]=0,r[14]=0,r[15]=0)}function j(r,a,v){var e=(a>>11&31)*R,A=(a>>5&63)*P,C=(a&31)*R,D=(v>>11&31)*R,f=(v>>5&63)*P,n=(v&31)*R;r[0]=e,r[1]=A,r[2]=C,r[3]=D,r[4]=f,r[5]=n,r[6]=5*e+3*D>>3,r[7]=5*A+3*f>>3,r[8]=5*C+3*n>>3,r[9]=5*D+3*e>>3,r[10]=5*f+3*A>>3,r[11]=5*n+3*C>>3}function c(r,a,v){r[0]=a,r[1]=v,a>v?(r[2]=54*a+9*v>>6,r[3]=45*a+18*v>>6,r[4]=36*a+27*v>>6,r[5]=27*a+36*v>>6,r[6]=18*a+45*v>>6,r[7]=9*a+54*v>>6):(r[2]=12*a+3*v>>4,r[3]=9*a+6*v>>4,r[4]=6*a+9*v>>4,r[5]=3*a+12*v>>4,r[6]=0,r[7]=255)}function N(r,a,v){r[0]=a,r[1]=v,a>v?(r[2]=(6*a+1*v)/7,r[3]=(5*a+2*v)/7,r[4]=(4*a+3*v)/7,r[5]=(3*a+4*v)/7,r[6]=(2*a+5*v)/7,r[7]=(1*a+6*v)/7):(r[2]=(4*a+1*v)/5,r[3]=(3*a+2*v)/5,r[4]=(2*a+3*v)/5,r[5]=(1*a+4*v)/5,r[6]=0,r[7]=1)}function l(r,a,v){for(var e=new Uint8Array(a*v*4),A=0,C=v/4;A<C;A++)for(var D=0,f=a/4;D<f;D++){var n=8*(A*f+D);u(S,r[n]+256*r[n+1],r[n+2]+256*r[n+3]);for(var x=A*16*a+D*16,F=r[n+4]|r[n+5]<<8|r[n+6]<<16|r[n+7]<<24,g=0;g<4;g++)for(var _=g*8,d=x+g*a*4,y=0;y<4;y++){var U=d+y*4,T=(F>>_+y*2&3)*4;e[U+0]=S[T+0],e[U+1]=S[T+1],e[U+2]=S[T+2],e[U+3]=S[T+3]}}return e}function o(r,a,v){for(var e=new Uint8Array(a*v*4),A=a*4,C=0,D=v/4;C<D;C++)for(var f=0,n=a/4;f<n;f++){var x=16*(C*n+f);j(i,r[x+8]+256*r[x+9],r[x+10]+256*r[x+11]);for(var F=C*16*a+f*16,g=0;g<4;g++){for(var _=r[x+g*2]+256*r[x+1+g*2],d=r[x+12+g],y=0;y<4;y++){var U=F+y*4,T=(d>>y*2&3)*3;e[U+0]=i[T+0],e[U+1]=i[T+1],e[U+2]=i[T+2],e[U+3]=(_>>y*4&15)*k}F+=A}}return e}function rr(r,a,v){for(var e=new Uint8Array(a*v*4),A=a*4,C=0,D=v/4;C<D;C++)for(var f=0,n=a/4;f<n;f++){var x=16*(C*n+f);c(m,r[x],r[x+1]),j(i,r[x+8]+256*r[x+9],r[x+10]+256*r[x+11]);for(var F=C*16*a+f*16,g=0;g<2;g++)for(var _=x+2+g*3,d=x+12+g*2,y=r[_]+256*(r[_+1]+256*r[_+2]),U=0;U<2;U++){for(var T=r[d+U],M=0;M<4;M++){var B=F+M*4,E=(T>>M*2&3)*3,q=y>>U*12+M*3&7;e[B+0]=i[E+0],e[B+1]=i[E+1],e[B+2]=i[E+2],e[B+3]=m[q]}F+=A}}return e}function ar(r,a,v){for(var e=new Uint8Array(a*v*4),A=a*2,C=0,D=v/4;C<D;C++)for(var f=0,n=a/4;f<n;f++){var x=16*(C*n+f);N(z,r[x],r[x+1]),N(G,r[x+8],r[x+9]);for(var F=C*8*a+f*8,g=0;g<2;g++)for(var _=x+g*3,d=r[_+2]+256*(r[_+3]+256*r[_+4]),y=r[_+10]+256*(r[_+11]+256*r[_+12]),U=0;U<2;U++){for(var T=U*4,M=0;M<4;M++){var B=F+M*2,E=3*(T+M);e[B*2+0]=z[d>>E&7],e[B*2+1]=G[y>>E&7]}F+=A}}return e}function er(r,a,v,e){if(a==="dxt1")return l(r,v,e);if(a==="dxt3")return o(r,v,e);if(a==="dxt5")return rr(r,v,e);if(a==="ati2")return ar(r,v,e);throw new Error("Unsupported format")}export{er as decodeDds,l as decodeDxt1,o as decodeDxt3,rr as decodeDxt5,ar as decodeRgtc,vr as parseHeaders};
/*! Bundled license information:

dds-parser/dist/es/dds-parser.js:
  (*!
      dds-parser v1.0.1
  	https://github.com/4eb0da/dds-parser
  	Released under the MIT License.
  *)
*/
//# sourceMappingURL=dds-parser.mjs.map