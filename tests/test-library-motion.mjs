// Motion Photos (row M6): finding the embedded MP4 from XMP, and readMetadata on a synthetic
// JPEG with an MP4 appended. Node only; the viewer's playback is not driven here.
import assert from 'node:assert/strict';
import { motionFromXmp, readMetadata } from '../src/library/metadata.js';
import { newRecord } from '../src/library/schema.js';

const container = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
 <rdf:Description rdf:about="" xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
   xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
   GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1" GCamera:MotionPhotoPresentationTimestampUs="968000">
  <Container:Directory><rdf:Seq>
   <rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0" Item:Padding="0"/></rdf:li>
   <rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="GainMap" Item:Length="2000"/></rdf:li>
   <rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="123456" Item:Padding="0"/></rdf:li>
  </rdf:Seq></Container:Directory>
 </rdf:Description></rdf:RDF></x:xmpmeta>`;
assert.deepEqual(motionFromXmp(container), { offset: 123456, length: 123456 }, 'Container form: the video is the last item');

// Element-style properties, and a video item that is not last (a trailing item adds to the offset).
const elements = `<GCamera:MotionPhoto>1</GCamera:MotionPhoto><Container:Directory><rdf:Seq>
  <rdf:li><Container:Item><Item:Mime>image/jpeg</Item:Mime><Item:Semantic>Primary</Item:Semantic><Item:Length>0</Item:Length><Item:Padding>8</Item:Padding></Container:Item></rdf:li>
  <rdf:li><Container:Item><Item:Mime>video/mp4</Item:Mime><Item:Semantic>MotionPhoto</Item:Semantic><Item:Length>5000</Item:Length><Item:Padding>4</Item:Padding></Container:Item></rdf:li>
  <rdf:li><Container:Item><Item:Mime>image/jpeg</Item:Mime><Item:Semantic>Depth</Item:Semantic><Item:Length>700</Item:Length></Container:Item></rdf:li>
</rdf:Seq></Container:Directory>`;
assert.deepEqual(motionFromXmp(elements), { offset: 5000 + 4 + 700, length: 5000 });

// The older GContainer form.
const gcontainer = `<rdf:Description GCamera:MicroVideo="1"><GContainer:Directory><rdf:Seq>
  <rdf:li><GContainer:Item GContainer:ItemMime="image/jpeg" GContainer:ItemSemantic="Primary"/></rdf:li>
  <rdf:li><GContainer:Item GContainer:ItemMime="video/mp4" GContainer:ItemSemantic="MotionPhoto" GContainer:ItemLength="4321"/></rdf:li>
</rdf:Seq></GContainer:Directory></rdf:Description>`;
assert.deepEqual(motionFromXmp(gcontainer), { offset: 4321, length: 4321 });

// The older MicroVideoOffset form.
const micro = `<rdf:Description GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1" GCamera:MicroVideoOffset="2481173" GCamera:MicroVideoPresentationTimestampUs="1066634"/>`;
assert.deepEqual(motionFromXmp(micro), { offset: 2481173, length: 2481173 });

// Not a Motion Photo.
assert.equal(motionFromXmp('<rdf:Description xmp:Rating="3"/>'), null);
assert.equal(motionFromXmp(container.replace('GCamera:MotionPhoto="1"', 'GCamera:MotionPhoto="0"')), null, 'MotionPhoto="0" is a still');
assert.equal(motionFromXmp(''), null);
assert.equal(motionFromXmp(undefined), null);

// readMetadata on a JPEG with an XMP APP1 block and an MP4 appended.
function jpegWithXmp(xmp, tail) {
  const head = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0' + xmp);
  const len = head.length + 2;
  return new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, len >> 8, len & 0xFF, ...head, 0xFF, 0xD9, ...tail]);
}
const mp4 = new Uint8Array(64); mp4.set([0, 0, 0, 24, ...new TextEncoder().encode('ftypisom')]);
const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" GCamera:MicroVideo="1" GCamera:MicroVideoOffset="64"/></rdf:RDF></x:xmpmeta>`;
{
  const f = new File([jpegWithXmp(xmp, mp4)], 'PXL_1.jpg', { lastModified: 1 });
  const m = await readMetadata(f, newRecord('r', 'PXL_1.jpg', f));
  assert.deepEqual(m.motion, { offset: 64, length: 64 });
  const clip = f.slice(f.size - m.motion.offset, f.size - m.motion.offset + m.motion.length);
  assert.equal(new TextDecoder().decode((await clip.arrayBuffer()).slice(4, 8)), 'ftyp', 'the slice is the MP4');
}
{
  // An offset that does not land on an MP4 is dropped.
  const f = new File([jpegWithXmp(xmp, new Uint8Array(64))], 'PXL_2.jpg', { lastModified: 1 });
  const m = await readMetadata(f, newRecord('r', 'PXL_2.jpg', f));
  assert.equal(m.motion, undefined);
}

console.log('test-library-motion: all passed');
