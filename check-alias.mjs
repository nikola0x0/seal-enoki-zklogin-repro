// Reproduce the Seal key server's `has_address_aliases` check (server.rs:151-186).
// Derive the AliasKey<address> derived-object ID and query Sui testnet for it.
//
// If get_object returns Ok → server.rs returns `Ok(true)` → cert verification
// short-circuits with InvalidSignature (== "User signature on the session
// key is invalid", the InvalidUserSignatureError seen in issue #531).

import { blake2b } from "@noble/hashes/blake2.js";
import { bcs } from "@mysten/sui/bcs";

const RPC = "https://fullnode.testnet.sui.io";

async function getObject(id) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "sui_getObject",
      params: [id, { showType: true, showOwner: true }],
    }),
  });
  return (await r.json()).result;
}

const SUI_FRAMEWORK = "0x0000000000000000000000000000000000000000000000000000000000000002";
const ADDRESS_ALIAS_STATE_OBJECT_ID =
  "0x000000000000000000000000000000000000000000000000000000000000000a";
const HASH_INTENT_CHILD_OBJECT_ID = 0xf0;

const ADDRESSES = {
  Enoki: "0x03bd4b65c7ee8b3911b21d214f380ed400798e944f200f902966343ac542cebf",
  Slush: "0x9826b0895f3adc08f2f4c8907640adf2f29351ec7829281050ded1020e296d5a",
};

const norm = (h) => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase().padStart(64, "0");
const fromHex = (h) => Uint8Array.from(Buffer.from(norm(h), "hex"));

function buildAliasKeyTypeTag() {
  // Inner: 0x2::address_alias::AliasKey
  return {
    struct: {
      address: norm(SUI_FRAMEWORK),
      module: "address_alias",
      name: "AliasKey",
      typeParams: [],
    },
  };
}

function buildWrapperTypeTag(innerTag) {
  // 0x2::derived_object::DerivedObjectKey<inner>
  return {
    struct: {
      address: norm(SUI_FRAMEWORK),
      module: "derived_object",
      name: "DerivedObjectKey",
      typeParams: [innerTag],
    },
  };
}

function deriveObjectId(parentHex, addressHex) {
  // 1. key_bytes = bcs::to_bytes(&address)  →  raw 32 bytes
  const keyBytes = fromHex(addressHex);

  // 2. wrapper_type_tag = DerivedObjectKey<AliasKey>
  const wrapperTag = buildWrapperTypeTag(buildAliasKeyTypeTag());
  const tagBytes = bcs.TypeTag.serialize(wrapperTag).toBytes();

  // 3. blake2b-256( 0xf0 || parent || key.len.u64_le || key || tag )
  const parent = fromHex(parentHex);
  const lenLE = new Uint8Array(8);
  new DataView(lenLE.buffer).setBigUint64(0, BigInt(keyBytes.length), true);

  const buf = new Uint8Array(1 + parent.length + 8 + keyBytes.length + tagBytes.length);
  let o = 0;
  buf[o++] = HASH_INTENT_CHILD_OBJECT_ID;
  buf.set(parent, o); o += parent.length;
  buf.set(lenLE, o); o += 8;
  buf.set(keyBytes, o); o += keyBytes.length;
  buf.set(tagBytes, o);

  const digest = blake2b(buf, { dkLen: 32 });
  return "0x" + Buffer.from(digest).toString("hex");
}

// --- self-test against derived_object.rs snapshot ---
// derive_object_id(0x2, Vector<U8>, bcs("foo")) → 0xa2b411aa9588c398d8e3bc97dddbdd430b5ded7f81545d05e33916c3ca0f30c3
{
  const innerTag = { vector: { u8: true } };
  const wrapperTag = buildWrapperTypeTag(innerTag);
  const tagBytes = bcs.TypeTag.serialize(wrapperTag).toBytes();
  const keyBytes = bcs.vector(bcs.u8()).serialize(new TextEncoder().encode("foo")).toBytes();
  const parent = fromHex(SUI_FRAMEWORK);
  const lenLE = new Uint8Array(8);
  new DataView(lenLE.buffer).setBigUint64(0, BigInt(keyBytes.length), true);
  const buf = new Uint8Array(1 + parent.length + 8 + keyBytes.length + tagBytes.length);
  let o = 0;
  buf[o++] = HASH_INTENT_CHILD_OBJECT_ID;
  buf.set(parent, o); o += parent.length;
  buf.set(lenLE, o); o += 8;
  buf.set(keyBytes, o); o += keyBytes.length;
  buf.set(tagBytes, o);
  const id = "0x" + Buffer.from(blake2b(buf, { dkLen: 32 })).toString("hex");
  const expect = "0xa2b411aa9588c398d8e3bc97dddbdd430b5ded7f81545d05e33916c3ca0f30c3";
  console.log(`self-test: ${id === expect ? "OK" : "MISMATCH"}`);
  console.log(`  expected: ${expect}`);
  console.log(`  got     : ${id}`);
}

for (const [label, addr] of Object.entries(ADDRESSES)) {
  const derivedId = deriveObjectId(ADDRESS_ALIAS_STATE_OBJECT_ID, addr);
  console.log(`\n${label}`);
  console.log(`  address  : ${addr}`);
  console.log(`  aliasKey : ${derivedId}`);
  const res = await getObject(derivedId);
  if (res?.data) {
    console.log(`  on-chain : type=${res.data.type}`);
    console.log(`             owner=${JSON.stringify(res.data.owner)}`);
    console.log(`  → has_address_aliases() returns Ok(true) → key server: InvalidSignature`);
  } else {
    console.log(`  on-chain : <not found>  (${res?.error?.code ?? "noResult"})`);
    console.log(`  → has_address_aliases() returns Ok(false) → cert verification proceeds`);
  }
}
