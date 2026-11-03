const {test}=require('node:test'),assert=require('node:assert/strict'),{pick}=require('../Public/js/cad-picking');
const rect=(x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
test('selects the last painted visible face, and falls through holes',()=>{const faces=[{index:1,points:rect(0,0,100,100)},{index:2,points:rect(20,20,60,60),holes:[rect(40,40,20,20)]}];assert.equal(pick({x:30,y:30},faces),2);assert.equal(pick({x:50,y:50},faces),1);assert.equal(pick({x:120,y:10},faces),-1);});
test('selects narrow projected edges and annotations',()=>{assert.equal(pick({x:50,y:1},[{index:4,points:rect(0,0,100,.001)}]),4);assert.equal(pick({x:25,y:2},[],[{index:7,a:{x:0,y:0},b:{x:50,y:0}}]),7);});
