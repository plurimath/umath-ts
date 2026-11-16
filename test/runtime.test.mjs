import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialize, Model, modelJson } from '../dist/index.js';
// Top-level await, not a before() hook: Node 22.0's runner starts
// top-level tests before an async root hook settles.
const parser=await initialize();
const samples=["x", "α", "x^2", "√x", "x/y"];
for(const input of samples)test('typed/raw shared-artifact parse: '+input,()=>{
 const value=parser.parse(input);assert(value instanceof Model.UmathModelDocument);
 assert.equal(value.decimal,'.');assert(value.expression!==null);
 const wire=modelJson.encodeUmathModelDocument(value);assert(wire && typeof wire==='object');
 assert(parser.parseTree(input)!==undefined);
});
test('decimal is a per-call option',()=>{assert.equal(parser.parse('1,5',{decimal:','}).decimal,',');assert.equal(parser.parse('1').decimal,'.')});
test('invalid options and Unicode fail explicitly',()=>{assert.throws(()=>parser.parse('x',{decimal:'?'}));assert.throws(()=>parser.parse('x',{engine:'ruby'}));assert.throws(()=>parser.parse('\ud800'))});
test('empty and labelled documents',()=>{assert.equal(parser.parse('').expression,null);assert.equal(parser.parse('x # q').label,' q')});
test('parslet compatibility keeps the Ruby producer tree for ∫₀ x y',()=>{
 const strict=JSON.stringify(parser.parseTree('∫₀ x y')),parslet=JSON.stringify(parser.parseTree('∫₀ x y',{compatibility:'parslet'}));
 assert.match(strict,/pre_subscript/);assert.doesNotMatch(parslet,/pre_subscript/);assert.match(parslet,/sub_exp/);
 assert.deepEqual(parser.parseTree('x^2',{compatibility:'parslet',reporter:'deepest'}),parser.parseTree('x^2'));
});
test('deepest refusals report caller offsets',()=>{
 for(const [input,byteOffset,charOffset] of [['α+)',3,2],['⁡x+)',4,2]])for(const options of [{},{compatibility:'parslet',reporter:'deepest'},{reporter:'deepest'}]){
  assert.throws(()=>parser.parseTree(input,options),error=>error.name==='ParseError'&&error.byteOffset===byteOffset&&error.charOffset===charOffset);
 }
 assert.throws(()=>parser.parse('x',{compatibility:'ruby'}),RangeError);assert.throws(()=>parser.parse('x',{reporter:'furthest'}),RangeError);
});
