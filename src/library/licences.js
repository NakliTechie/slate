// Every third-party package Slate uses, for the Licences section in Help.
// `bundled` packages are vendored under src/vendor/ and built into index.html, so their
// licence text ships here and in the vendored file's header. `esm.sh` packages are
// fetched from esm.sh the first time a matching file is opened (see SECURITY.md), and
// carry their own licence in what esm.sh serves.
// tests/test-licences.mjs keeps this list in step with src/vendor/ and README.md's Credits.

export const LICENCES = [
  { name: 'exifr', version: '7.1.3', licence: 'MIT', loaded: 'bundled', use: 'Photo dates, camera and place for the library', source: 'https://github.com/MikeKovarik/exifr',
    text: `MIT License

Copyright (c) 2020 Mike Kovařík, Mutiny.cz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.` },
  { name: 'tga-js', version: '1.1.1', licence: 'MIT', loaded: 'bundled', use: 'Targa decode', source: 'https://github.com/vthibault/tga.js',
    text: `Copyright (c) 2013-2020 Vincent Thibault, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.` },
  { name: 'dds-parser', version: '1.0.1', licence: 'MIT', loaded: 'bundled', use: 'DirectDraw Surface decode', source: 'https://github.com/4eb0da/dds-parser',
    text: `MIT License

Copyright (c) 2017-2023 4eb0da

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.` },
  { name: 'utif', version: '3.1.0', licence: 'MIT', loaded: 'esm.sh', use: 'TIFF read and write', source: 'https://github.com/photopea/UTIF.js' },
  { name: 'pako', version: '1.x and 2.1.0', licence: 'MIT and Zlib', loaded: 'esm.sh', use: 'Inflate, fetched with utif and ag-psd', source: 'https://github.com/nodeca/pako' },
  { name: 'libheif-js', version: '1.19.8', licence: 'LGPL-3.0', loaded: 'esm.sh', use: 'HEIC and HEIF decode where the browser has none', source: 'https://github.com/catdad-experiments/libheif-js' },
  { name: '@jsquash/jxl', version: '1.3.0', licence: 'Apache-2.0', loaded: 'esm.sh', use: 'JPEG XL decode', source: 'https://github.com/jamsinclair/jSquash' },
  { name: 'wasm-feature-detect', version: '1.x', licence: 'Apache-2.0', loaded: 'esm.sh', use: 'Fetched with @jsquash/jxl', source: 'https://github.com/GoogleChromeLabs/wasm-feature-detect' },
  { name: 'ag-psd', version: '30.1.1', licence: 'MIT', loaded: 'esm.sh', use: 'Photoshop decode', source: 'https://github.com/Agamnentzar/ag-psd' },
  { name: 'base64-js', version: '1.5.1', licence: 'MIT', loaded: 'esm.sh', use: 'Fetched with ag-psd', source: 'https://github.com/beatgammit/base64-js' },
];
