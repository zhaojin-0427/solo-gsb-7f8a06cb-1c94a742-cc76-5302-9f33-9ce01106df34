/**
 * 层叠引擎测试（零依赖，node test/engine.test.js）。
 */
import assert from 'node:assert/strict';
import {
  LAYER_PLAN_MAX_ELEMENTS,
  LAYER_PLAN_MAX_LAYERS,
  LAYER_PLAN_MAX_RULES,
  LAYER_PLAN_MAX_TARGETS,
  analyzeElement,
  compileRules,
  computeAllStyles,
  countElements,
  decodeCharRefs,
  findByPath,
  matchesSelector,
  parseHtml,
  parseSelector,
  planLayerOrder,
  simplifyRules,
  uniqueLocator,
} from '../src/engine.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function winners(html, rules, path, prop) {
  const { roots } = parseHtml(html);
  const node = findByPath(roots, path);
  const { compiled } = compileRules(rules);
  const result = analyzeElement(node, prop, compiled);
  return { result, value: result[0]?.value ?? null, layerOrder: compileRules(rules).layerOrder };
}

const R = (selector, property, value, { layer = '', important = false } = {}) =>
  ({ selector, property, value, layer, important });

/* ---------- HTML 解析 ---------- */

test('parseHtml：正确建立树、id、class 与路径', () => {
  const { roots, errors } = parseHtml(
    '<div id="a" class="x y"><section><p class="z">hi</p></section><span></span></div>'
  );
  assert.deepEqual(errors, []);
  assert.equal(roots.length, 1);
  const div = roots[0];
  assert.equal(div.tag, 'div');
  assert.equal(div.id, 'a');
  assert.deepEqual(div.classes, ['x', 'y']);
  assert.equal(div.path, '0');
  assert.equal(div.children[0].tag, 'section');
  assert.equal(div.children[0].path, '0.0');
  assert.equal(div.children[0].children[0].tag, 'p');
  assert.equal(div.children[0].children[0].path, '0.0.0');
  assert.equal(div.children[1].tag, 'span');
  assert.equal(div.children[1].path, '0.1');
});

test('parseHtml：不支持的标签 / 属性 / 自闭合 / 空 id 均报错', () => {
  assert.ok(parseHtml('<ul></ul>').errors.length);
  assert.ok(parseHtml('<div data-x="1"></div>').errors.length);
  assert.ok(parseHtml('<div onclick="x()"></div>').errors.length);
  assert.ok(parseHtml('<script>alert(1)</script>').errors.length);
  assert.ok(parseHtml('<div id="" ></div>').errors.length);
  assert.ok(parseHtml('<div/>').errors.length);
  assert.ok(parseHtml('<span />').errors.length);
  assert.ok(parseHtml('<div id="a" id="b"></div>').errors.length);
  assert.ok(parseHtml('<div class="a" class="b"></div>').errors.length);
  assert.equal(parseHtml('<div id="a" class="b">纯文本</div>').errors.length, 0);
});

/* ---------- 字符引用解码（与浏览器一致） ---------- */

test('decodeCharRefs：数字与命名引用按浏览器规则解码', () => {
  assert.equal(decodeCharRefs('foo&#32;bar'), 'foo bar');
  assert.equal(decodeCharRefs('foo&#x20;bar'), 'foo bar');
  assert.equal(decodeCharRefs('foo&#32bar'), 'foo bar');       // 分号可省略（十进制）
  assert.equal(decodeCharRefs('a&#x3c'), 'a<');                // 分号可省略（十六进制）
  assert.equal(decodeCharRefs('a&amp;b'), 'a&b');
  assert.equal(decodeCharRefs('&lt;div&gt;'), '<div>');
  assert.equal(decodeCharRefs('&apos;'), "'");
  assert.equal(decodeCharRefs('&#0;'), '�');              // 空码位 → U+FFFD
  assert.equal(decodeCharRefs('&#xD800;'), '�');          // 代理项 → U+FFFD
  assert.equal(decodeCharRefs('&#x110000;'), '�');        // 超出范围 → U+FFFD
  assert.equal(decodeCharRefs('&#128;'), '€');                 // C1 控制区映射
  assert.equal(decodeCharRefs('&nosuchref;'), '&nosuchref;');  // 未知引用保持原样
  assert.equal(decodeCharRefs('&#;'), '&#;');                  // 无数字保持原样
  assert.equal(decodeCharRefs('a&nbsp;b'), 'a b');      // nbsp → U+00A0
});

test('decodeCharRefs：属性中的历史规则（无分号遗留引用后接 = 或字母数字则不解码）', () => {
  assert.equal(decodeCharRefs('a&ltb', { inAttribute: true }), 'a&ltb');
  assert.equal(decodeCharRefs('a&lt=b', { inAttribute: true }), 'a&lt=b');
  assert.equal(decodeCharRefs('a&lt b', { inAttribute: true }), 'a< b');
  assert.equal(decodeCharRefs('a&lt;b', { inAttribute: true }), 'a<b'); // 有分号总是解码
  assert.equal(decodeCharRefs('a&ltb'), 'a<b'); // 非属性场景无此限制
});

test('parseHtml：class/id 中的字符引用先解码再使用', () => {
  const { roots, errors } = parseHtml('<div><p class="foo&#32;bar">x</p></div>');
  assert.deepEqual(errors, []);
  const p = roots[0].children[0];
  assert.deepEqual(p.classes, ['foo', 'bar']);
  // &nbsp; 解码为 U+00A0，不作为 class 分隔符（与浏览器 classList 一致）
  const { roots: r2 } = parseHtml('<p class="a&nbsp;b"></p>');
  assert.deepEqual(r2[0].classes, ['a b']);
  const { roots: r3 } = parseHtml('<p id="x&#x41;y" class="a&gt;b"></p>');
  assert.equal(r3[0].id, 'xAy');
  assert.deepEqual(r3[0].classes, ['a>b']);
});

test('字符引用解码后规则匹配与预览一致（.foo 命中 class="foo&#32;bar"）', () => {
  const html = '<div><p class="foo&#32;bar">x</p></div>';
  const rules = [R('.foo', 'color', 'red')];
  const r = winners(html, rules, '0.0', 'color');
  assert.equal(r.value, 'red');
  assert.equal(r.result[0].winner, true);
  const { roots } = parseHtml(html);
  const { compiled } = compileRules(rules);
  assert.equal(computeAllStyles(roots, compiled)['0.0'].color, 'red');
});

/* ---------- 浏览器式树构造（隐式闭合等） ---------- */

test('parseHtml：p 被块级开始标签隐式闭合，与浏览器预览同树同路径', () => {
  // 浏览器 DOM：p(a)、div(b)、孤立 </p> 生成的空 p —— 三个根元素
  const { roots, errors } = parseHtml('<p>a<div>b</div></p>');
  assert.deepEqual(errors, []);
  assert.equal(roots.length, 3);
  assert.equal(roots[0].tag, 'p');
  assert.equal(roots[0].path, '0');
  assert.equal(roots[1].tag, 'div');
  assert.equal(roots[1].path, '1');
  assert.equal(roots[2].tag, 'p');
  assert.equal(roots[2].path, '2');
  assert.equal(roots[2].children.length, 0);
});

test('parseHtml：隐式闭合后的规则匹配与点击路径以预览节点为准', () => {
  const html = '<p>a<div class="x">b</div></p>';
  const rules = [R('div.x', 'color', 'red')];
  // div 是第二个根元素（路径 "1"），而不是 p 的子元素
  assert.equal(winners(html, rules, '1', 'color').value, 'red');
  const { roots } = parseHtml(html);
  const { compiled } = compileRules(rules);
  const styles = computeAllStyles(roots, compiled);
  assert.equal(styles['1'].color, 'red');
  assert.equal(styles['0'], undefined);
});

test('parseHtml：p 嵌套 p、跨 span 的 p 均按浏览器规则闭合', () => {
  const { roots } = parseHtml('<p>a<p>b');
  assert.equal(roots.length, 2);
  assert.equal(roots[0].tag, 'p');
  assert.equal(roots[1].tag, 'p');
  // <p><span>x<div>：div 闭合 p（连同 span 一起弹出）
  const { roots: r2 } = parseHtml('<p><span>x<div>y</div>');
  assert.equal(r2.length, 2);
  assert.equal(r2[0].tag, 'p');
  assert.equal(r2[0].children[0].tag, 'span');
  assert.equal(r2[1].tag, 'div');
});

test('parseHtml：结束标签的浏览器式恢复（隐式闭合 / 忽略 / 空 p）', () => {
  // <div><p>x</div>：</div> 隐式闭合 p
  const { roots: r1, errors: e1 } = parseHtml('<div><p>x</div>');
  assert.deepEqual(e1, []);
  assert.equal(r1[0].children[0].tag, 'p');
  // <div><span>x</div>：</div> 弹出 span 后闭合 div
  const { roots: r2, errors: e2 } = parseHtml('<div><span>x</div>');
  assert.deepEqual(e2, []);
  assert.equal(r2[0].children[0].tag, 'span');
  // 多余的 </div> 被浏览器忽略
  const { roots: r3, errors: e3 } = parseHtml('<div></div></div>');
  assert.deepEqual(e3, []);
  assert.equal(r3.length, 1);
  // 孤立的 </p> 生成空 p
  const { roots: r4, errors: e4 } = parseHtml('</p>');
  assert.deepEqual(e4, []);
  assert.equal(r4.length, 1);
  assert.equal(r4[0].tag, 'p');
  // <p><span>x</p>：</p> 把 span 一并弹出，span 仍是 p 的子元素
  const { roots: r5 } = parseHtml('<p><span>x</p>');
  assert.equal(r5[0].tag, 'p');
  assert.equal(r5[0].children[0].tag, 'span');
  // <span><p>x</span>：</span> 被 special 类别的 p 挡住，忽略
  const { roots: r6 } = parseHtml('<span><p>x</span>y');
  assert.equal(r6.length, 1);
  assert.equal(r6[0].tag, 'span');
  assert.equal(r6[0].children[0].tag, 'p');
});

test('parseHtml：EOF 自动闭合未闭合标签（与浏览器一致，不报错）', () => {
  const { roots, errors } = parseHtml('<div><p>x');
  assert.deepEqual(errors, []);
  assert.equal(roots[0].tag, 'div');
  assert.equal(roots[0].children[0].tag, 'p');
  assert.equal(roots[0].children[0].path, '0.0');
});

test('parseHtml：span 不会隐式闭合 p；div 可位于 span 内', () => {
  const { roots } = parseHtml('<p>a<span>b</span>c</p>');
  assert.equal(roots.length, 1);
  assert.equal(roots[0].children[0].tag, 'span');
  const { roots: r2 } = parseHtml('<span>a<div>b</div></span>');
  assert.equal(r2[0].tag, 'span');
  assert.equal(r2[0].children[0].tag, 'div');
});

/* ---------- 选择器解析 ---------- */

test('parseSelector：合法选择器与特异性', () => {
  assert.deepEqual(parseSelector('div').specificity, [0, 0, 1]);
  assert.deepEqual(parseSelector('#a.b div').specificity, [1, 1, 1]);
  assert.deepEqual(parseSelector('section > p.text').specificity, [0, 1, 2]);
  assert.deepEqual(parseSelector('  span.x  >  #y ').parts.length, 2);
  assert.equal(parseSelector('section > p').parts[1].combinator, 'child');
  assert.equal(parseSelector('section p').parts[1].combinator, 'descendant');
});

test('parseSelector：非法语法抛错', () => {
  for (const bad of ['', '   ', '>', 'div >', '> div', 'div >> p', 'div + p',
    'div p *', '#123', '.a.', 'ul li', 'div{}', 'a,b', 'div  >  > p']) {
    assert.throws(() => parseSelector(bad), undefined, `应当报错：${bad}`);
  }
});

test('matchesSelector：后代与直接子代', () => {
  const { roots } = parseHtml('<div id="a"><section class="b"><p class="t"><span>x</span></p></section></div>');
  const span = findByPath(roots, '0.0.0.0');
  const p = findByPath(roots, '0.0.0');
  assert.equal(matchesSelector(span, parseSelector('div span')), true);
  assert.equal(matchesSelector(span, parseSelector('div > span')), false);
  assert.equal(matchesSelector(span, parseSelector('#a .b p > span')), true);
  assert.equal(matchesSelector(span, parseSelector('section > span')), false);
  assert.equal(matchesSelector(p, parseSelector('p.t')), true);
  assert.equal(matchesSelector(p, parseSelector('#a section p')), true);
  assert.equal(matchesSelector(p, parseSelector('.b > p')), true);
});

/* ---------- 层叠规则 ---------- */

test('important 优先于普通声明', () => {
  const html = '<p class="a"></p>';
  assert.equal(winners(html, [R('p', 'color', 'red'), R('.a', 'color', 'blue', { important: true })], '0', 'color').value, 'blue');
  assert.equal(winners(html, [R('.a', 'color', 'blue', { important: true }), R('p', 'color', 'red')], '0', 'color').value, 'blue');
});

test('普通声明：无层高于有层', () => {
  const html = '<p></p>';
  assert.equal(winners(html, [
    R('p', 'color', 'layered', { layer: 'x' }),
    R('p', 'color', 'unlayered'),
  ], '0', 'color').value, 'unlayered');
});

test('普通声明：有层时后层优先', () => {
  const html = '<p></p>';
  assert.equal(winners(html, [
    R('p', 'color', 'first', { layer: 'a' }),
    R('p', 'color', 'second', { layer: 'b' }),
  ], '0', 'color').value, 'second');
});

test('层顺序按首次出现确定（规则顺序不影响层顺序）', () => {
  const html = '<p class="x"></p>';
  const rules = [
    R('.x', 'color', 'b-val', { layer: 'b' }),
    R('p', 'color', 'a-val', { layer: 'a' }),
  ];
  // 层顺序为 [b, a]：b 先出现，普通声明后层 a 优先，尽管 a 的特异性更低
  assert.deepEqual(winners(html, rules, '0', 'color').layerOrder, ['b', 'a']);
  assert.equal(winners(html, rules, '0', 'color').value, 'a-val');
});

test('important：有层高于无层', () => {
  const html = '<p></p>';
  assert.equal(winners(html, [
    R('p', 'color', 'unlayered-imp', { important: true }),
    R('p', 'color', 'layered-imp', { layer: 'x', important: true }),
  ], '0', 'color').value, 'layered-imp');
});

test('important：有层时先层优先', () => {
  const html = '<p class="a"></p>';
  const rules = [
    R('p', 'color', 'early', { layer: 'early', important: true }),
    R('p.a', 'color', 'late', { layer: 'late', important: true }),
  ];
  // late 规则特异性更高，但 early 层先出现 → early 胜出
  assert.equal(winners(html, rules, '0', 'color').value, 'early');
});

test('同层：ID > 类 > 类型', () => {
  const html = '<div id="m" class="c"><p class="t"></p></div>';
  const path = '0.0';
  assert.equal(winners(html, [R('p', 'color', 'type'), R('.c .t', 'color', 'class'), R('#m p', 'color', 'id')], path, 'color').value, 'id');
  assert.equal(winners(html, [R('p', 'color', 'type'), R('.c .t', 'color', 'class')], path, 'color').value, 'class');
  assert.equal(winners(html, [R('p', 'color', 'type'), R('div p', 'color', 'type2')], path, 'color').value, 'type2');
});

test('特异性相同：规则顺序靠后者优先', () => {
  const html = '<p></p>';
  const r = winners(html, [R('p', 'color', 'first'), R('p', 'color', 'second')], '0', 'color');
  assert.equal(r.value, 'second');
  assert.match(r.result[1].reason, /规则顺序/);
});

test('落败原因逐级准确', () => {
  const html = '<p class="a"></p>';
  const r = winners(html, [
    R('p', 'color', 'red'),
    R('p', 'color', 'green', { layer: 'early', important: true }),
    R('p.a', 'color', 'blue', { layer: 'late', important: true }),
  ], '0', 'color');
  assert.equal(r.value, 'green');
  const reasons = r.result.map((d) => d.reason);
  assert.equal(reasons[0], null);
  assert.match(reasons[1], /先出现的层/);   // blue 位于后出现的 late 层
  assert.match(reasons[2], /!important/);  // red 是普通声明
});

test('只分析指定属性；不匹配的选择器不参与；无匹配时为空', () => {
  const html = '<div><p>x</p></div>';
  const rules = [R('p', 'color', 'red'), R('span', 'color', 'blue'), R('p', 'font-size', '16px')];
  const r = winners(html, rules, '0.0', 'color');
  assert.equal(r.value, 'red');
  assert.equal(r.result.length, 1);
  assert.equal(winners(html, rules, '0.0', 'background-color').value, null);
  assert.equal(winners(html, rules, '0', 'color').value, null);
});

test('computeAllStyles：全树胜出值计算', () => {
  const html = '<section><p class="a">1</p><p>2</p></section>';
  const rules = [R('p', 'color', 'red'), R('.a', 'color', 'green'), R('section p', 'font-size', '14px')];
  const { roots } = parseHtml(html);
  const { compiled } = compileRules(rules);
  const styles = computeAllStyles(roots, compiled);
  assert.equal(styles['0.0'].color, 'green');
  assert.equal(styles['0.0']['font-size'], '14px');
  assert.equal(styles['0.1'].color, 'red');
  assert.equal(styles['0.1']['font-size'], '14px');
  assert.equal(styles['0'], undefined);
});

test('规则校验：非法选择器、属性、值、层名进入 errors 且不参与计算', () => {
  const { compiled, errors } = compileRules([
    R('div + p', 'color', 'red'),
    R('p', 'margin', '10px'),
    R('p', 'color', ''),
    R('p', 'color', 'red', { layer: '1bad' }),
    R('p', 'color', 'green'),
  ]);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].value, 'green');
  assert.deepEqual(errors.map((e) => e.index), [0, 1, 2, 3]);
});

/* ---------- 等价精简 ---------- */

function simplify(html, rules) {
  const { roots, errors } = parseHtml(html);
  assert.deepEqual(errors, []);
  return simplifyRules(roots, rules);
}

/** 精简结果必须真的与原规则集层叠结果完全一致（含无声明状态）。 */
function assertEquivalent(html, rules, kept) {
  const { roots } = parseHtml(html);
  const before = compileRules(rules);
  const after = compileRules(kept.map((i) => rules[i]));
  assert.deepEqual(after.layerOrder, simplify(html, rules).layerOrder);
  const walk = (node) => {
    for (const prop of ['color', 'background-color', 'font-size']) {
      const b = analyzeElement(node, prop, before.compiled)[0]?.value ?? null;
      const a = analyzeElement(node, prop, after.compiled)[0]?.value ?? null;
      assert.equal(a, b, `元素 ${node.path} 的 ${prop} 精简后由 ${b} 变为 ${a}`);
    }
    node.children.forEach((c) => walk(c));
  };
  roots.forEach(walk);
}

test('countElements：统计全树元素数', () => {
  assert.equal(countElements(parseHtml('<div><p>a</p><p>b<span></span></p></div>').roots), 4);
  assert.equal(countElements(parseHtml('').roots), 0);
  assert.equal(countElements(parseHtml('<p>a<div>b</div></p>').roots), 3);
});

test('等价精简：删除全部声明也不改变胜出值（无匹配规则）→ 空集', () => {
  const html = '<div><p>x</p></div>';
  const rules = [R('span', 'color', 'red'), R('div span', 'font-size', '16px', { layer: 'a' })];
  const r = simplify(html, rules);
  assert.deepEqual(r.kept, []);
  assert.deepEqual(r.removed, [0, 1]);
  assert.deepEqual(r.layerOrder, []);
  assertEquivalent(html, rules, r.kept);
});

test('等价精简：空规则集 → 保留空集', () => {
  const r = simplify('<p></p>', []);
  assert.deepEqual(r.kept, []);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.layerOrder, []);
});

test('等价精简：落败且无处胜出的规则可删；胜出规则必须保留', () => {
  const html = '<p class="a"></p>';
  const rules = [
    R('p', 'color', 'red'),                          // 0 胜出（无层）
    R('p', 'color', 'blue', { layer: 'x' }),         // 1 落败（有层低于无层）
    R('p', 'font-size', '14px', { layer: 'y' }),     // 2 在 font-size 胜出
  ];
  const r = simplify(html, rules);
  assert.deepEqual(r.kept, [0, 2]);
  assert.deepEqual(r.removed, [1]);
  // 删除规则 1 后层 y 成为（也是唯一的）层；新层顺序由剩余规则重算
  assert.deepEqual(r.originalLayerOrder, ['x', 'y']);
  assert.deepEqual(r.layerOrder, ['y']);
  assertEquivalent(html, rules, r.kept);
});

test('等价精简：同值替代时取保留原序号字典序最小者', () => {
  const html = '<p></p>';
  // 两条无层、同特异性、同值声明：任一胜出都给出 red
  const rules = [
    R('p', 'color', 'red'),  // 0
    R('p', 'color', 'red'),  // 1
  ];
  const r = simplify(html, rules);
  assert.deepEqual(r.kept, [0]);
  assert.deepEqual(r.removed, [1]);
  assertEquivalent(html, rules, r.kept);

  // 规则 0 选择器不匹配任何元素，规则 1 才是唯一赢家
  const rules2 = [
    R('span', 'color', 'red'),  // 0 不匹配
    R('p', 'color', 'red'),     // 1 胜出
  ];
  const r2 = simplify(html, rules2);
  assert.deepEqual(r2.kept, [1]);
  assertEquivalent(html, rules2, r2.kept);
});

test('等价精简：层叠替换场景——删掉胜出者后由落败者顶替且值必须相同', () => {
  const html = '<p class="a"></p>';
  // 0：无层 red 胜出；1：有层 red 落败。删除 0 后 1 顶替，胜出值仍为 red
  const rules = [
    R('p', 'color', 'red'),
    R('p', 'color', 'red', { layer: 'L' }),
    R('p', 'color', 'blue', { layer: 'L' }),
  ];
  const r = simplify(html, rules);
  assert.deepEqual(r.kept, [0]);
  assert.deepEqual(r.removed, [1, 2]);
  // 仅保留无层规则时层顺序为空，确属按剩余规则重新计算
  assert.deepEqual(r.layerOrder, []);
  assertEquivalent(html, rules, r.kept);

  // 顶替者值不同：胜出规则不可删除（但 blue 落败规则本身仍可删，仅留 0 即等价）
  const rulesBad = [
    R('p', 'color', 'red'),
    R('p', 'color', 'blue', { layer: 'L' }),
  ];
  const rb = simplify(html, rulesBad);
  assert.deepEqual(rb.kept, [0]);
  assert.deepEqual(rb.removed, [1]);
});

test('等价精简：无声明状态必须保持（删掉唯一规则会使有值元素变为无声明）', () => {
  const html = '<div><p>x</p></div>';
  // p 的 color 有值；div 的三个属性全无声明
  const rules = [R('p', 'color', 'red')];
  const r = simplify(html, rules);
  assert.deepEqual(r.kept, [0]);
  assertEquivalent(html, rules, r.kept);
  // 空候选下 p.color 变为 null，与原结果不同，故不可全删
  const { roots } = parseHtml(html);
  assert.equal(computeAllStyles(roots, compileRules([]).compiled)['0.0'], undefined);
  assert.equal(computeAllStyles(roots, compileRules(rules).compiled)['0.0'].color, 'red');
});

test('等价精简：每个候选独立重算层顺序，不依赖"曾胜出"标记', () => {
  const html = '<p class="a"></p>';
  const rules = [
    R('span', 'color', 'red', { layer: 'b' }),  // 0：无任何元素匹配，仅决定层 b 先出现
    R('.a', 'color', 'red', { layer: 'a' }),    // 1：层 a 后出现且特异性高，red 胜出
    R('p', 'color', 'blue', { layer: 'a' }),    // 2：同层 a 但特异性低，落败
  ];
  // 原层顺序 [b, a]；删除 0、2 后只剩规则 1，层顺序按剩余规则重算为 [a]，red 仍胜
  const r = simplify(html, rules);
  assert.deepEqual(r.originalLayerOrder, ['b', 'a']);
  assert.deepEqual(r.kept, [1]);
  assert.deepEqual(r.removed, [0, 2]);
  assert.deepEqual(r.layerOrder, ['a']);
  // 不能只保留 2：blue 会顶替胜出
  assertEquivalent(html, rules, r.kept);
});

test('等价精简：结果为最小值（任何真子集都不再等价）', () => {
  const html = '<section><p class="a">1</p><p>2</p></section>';
  const rules = [
    R('p', 'color', 'red'),
    R('.a', 'color', 'green'),
    R('section p', 'font-size', '14px'),
    R('p', 'color', 'red'),    // 与 0 同值同特异性重复（靠后者胜，但值相同）
    R('span', 'color', 'red'), // 不匹配
  ];
  const r = simplify(html, rules);
  // 0/3 二选一（字典序取 0）；1、2 各自唯一负责；4 可删
  assert.deepEqual(r.kept, [0, 1, 2]);
  assertEquivalent(html, rules, r.kept);
});

/* ---------- 唯一选择器 ---------- */

function locator(html, path) {
  const { roots, errors } = parseHtml(html);
  assert.deepEqual(errors, []);
  const node = findByPath(roots, path);
  assert.ok(node, `路径 ${path} 应存在`);
  return uniqueLocator(roots, node);
}

test('唯一选择器：目标段本身唯一时返回 1 段最优', () => {
  // 目标 p 是全树唯一的 p
  assert.deepEqual(locator('<div id="main"><p>x</p></div>', '0.0'), { selector: 'p', segments: 1 });
  // id 与 class 都唯一：等长时字典序 '#' 在 '.' 前
  assert.deepEqual(locator('<div><p id="zz" class="aa">x</p><p>y</p></div>', '0.0'), { selector: '#zz', segments: 1 });
  // 类型段唯一时直接用最短的类型段
  assert.deepEqual(locator('<div><section><p>x</p></section></div>', '0.0'), { selector: 'section', segments: 1 });
});

test('唯一选择器：同段数先比字符串长度，再比字典序', () => {
  // .aa(4) 短于 #zzzzz(6)，即使 '#' 字典序更小
  assert.deepEqual(locator('<div><p id="zzzzz" class="aa">x</p><p>y</p></div>', '0.0'), { selector: '.aa', segments: 1 });
  // 多个唯一 class：等长取字典序最小
  assert.deepEqual(locator('<div><p class="bb aa">1</p><p>2</p></div>', '0.0'), { selector: '.aa', segments: 1 });
});

test('唯一选择器：1 段不唯一时用 2 段，等长时后代空格字典序小于 >', () => {
  const html = '<div><p class="a">1</p><section><p class="a">2</p></section></div>';
  // 目标 section 内的 p：p / .a 均命中 2 个；section p 与 section>p 等长，空格更小
  assert.deepEqual(locator(html, '0.1.0'), { selector: 'section p', segments: 2 });
});

test('唯一选择器：唯一性验证在整棵树上进行', () => {
  // .x 在另一棵子树中也出现：1 段 .x 不唯一；#a p 为 2 段最优
  const html = '<div id="a"><p class="x">1</p></div><div><p class="x">2</p></div>';
  assert.deepEqual(locator(html, '0.0'), { selector: '#a p', segments: 2 });
});

test('唯一选择器：需要 3 段时返回 3 段最优', () => {
  const html = '<div><div><section><p>1</p></section></div></div><div><section><p>2</p></section></div>';
  // p1 的祖先段（div / section）与 p2 完全同构，任意 1、2 段都同时命中两者；
  // div div p 与 div>div p 等长，空格字典序更小
  assert.deepEqual(locator(html, '0.0.0.0'), { selector: 'div div p', segments: 3 });
});

test('唯一选择器：非法 id / class 不作为段', () => {
  // #1a 非法（数字开头）：唯一可区分特征不可用 → 无候选
  assert.equal(locator('<section><p id="1a">x</p><p>y</p></section>', '0.0').selector, null);
  // 合法 id 时同样结构可解
  assert.deepEqual(locator('<section><p id="a1">x</p><p>y</p></section>', '0.0'), { selector: '#a1', segments: 1 });
  // class 含非法字符（解码出的 ">"）同样不作为段，但合法 class 可用
  assert.deepEqual(locator('<div><p class="a&gt;b ok">x</p><p>y</p></div>', '0.0'), { selector: '.ok', segments: 1 });
});

test('唯一选择器：祖先段至多取最近 7 层', () => {
  // #far 是目标的第 8 层祖先，不可用；7 层内与另一棵同构子树无法区分 → 无候选
  const inner = '<div>'.repeat(7) + '<p>1</p>' + '</div>'.repeat(7);
  const html = `<div id="far">${inner}</div>` + '<div>'.repeat(7) + '<p>2</p>' + '</div>'.repeat(7);
  assert.equal(locator(html, '0.0.0.0.0.0.0.0.0').selector, null);
  // 同一结构去掉一层后 #far 进入最近 7 层 → #far p 唯一
  const inner7 = '<div>'.repeat(6) + '<p>1</p>' + '</div>'.repeat(6);
  const html7 = `<div id="far">${inner7}</div>` + '<div>'.repeat(7) + '<p>2</p>' + '</div>'.repeat(7);
  assert.deepEqual(locator(html7, '0.0.0.0.0.0.0.0'), { selector: '#far p', segments: 2 });
});

test('唯一选择器：完全同构的子树无法区分时返回无候选', () => {
  const html = '<div><p>1</p><p>2</p></div>';
  assert.equal(locator(html, '0.0').selector, null);
  assert.equal(locator(html, '0.1').selector, null);
});

test('唯一选择器：结果确实在整棵树上只命中目标（含 40 元素规模）', () => {
  const html = `<div>${'<p>x</p>'.repeat(38)}<p class="target">x</p></div>`;
  const { roots, errors } = parseHtml(html);
  assert.deepEqual(errors, []);
  assert.equal(countElements(roots), 40);
  const r = locator(html, '0.38');
  assert.deepEqual(r, { selector: '.target', segments: 1 });
  // 用现有匹配规则复核：全树只有目标命中
  const node = findByPath(roots, '0.38');
  const parsed = parseSelector(r.selector);
  const hits = [];
  const walk = (n) => {
    if (matchesSelector(n, parsed)) hits.push(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  assert.deepEqual(hits, [node]);
});

/* ---------- 层顺序规划 ---------- */

function plan(html, rules, targets) {
  const { roots, errors } = parseHtml(html);
  assert.deepEqual(errors, []);
  return planLayerOrder(roots, rules, targets);
}

const T = (path, property, value) => ({ path, property, value });

test('层顺序规划：普通声明后层优先，统计与最优排列', () => {
  const html = '<p class="a">x</p>';
  const rules = [
    R('p', 'color', 'red', { layer: 'a' }),   // 0 → 层 a 编号 1
    R('p', 'color', 'blue', { layer: 'b' }),  // 1 → 层 b 编号 2
  ];
  // 目标 red：层 a 必须排在层 b 之后 → 唯一可行排列 [b, a]
  const r = plan(html, rules, [T('0', 'color', 'red')]);
  assert.equal(r.count, 1);
  assert.equal(r.totalPermutations, 2);
  assert.deepEqual(r.permutation, ['b', 'a']);
  assert.deepEqual(r.permutationNumbers, [2, 1]);
  assert.equal(r.winners[0].ruleIndex, 0);
  assert.equal(r.winners[0].value, 'red');
  // 目标 blue：层 b 在后 → 排列 [a, b]
  const r2 = plan(html, rules, [T('0', 'color', 'blue')]);
  assert.equal(r2.count, 1);
  assert.deepEqual(r2.permutation, ['a', 'b']);
  assert.equal(r2.winners[0].ruleIndex, 1);
});

test('层顺序规划：!important 先层优先', () => {
  const html = '<p class="a">x</p>';
  const rules = [
    R('p', 'color', 'red', { layer: 'a', important: true }),   // 0
    R('p.a', 'color', 'blue', { layer: 'b', important: true }), // 1 特异性更高
  ];
  // important 有层时先层优先：目标 blue 要求层 b 排在层 a 之前
  const r = plan(html, rules, [T('0', 'color', 'blue')]);
  assert.equal(r.count, 1);
  assert.deepEqual(r.permutation, ['b', 'a']);
  assert.equal(r.winners[0].ruleIndex, 1);
  // 目标 red：层 a 在前
  const r2 = plan(html, rules, [T('0', 'color', 'red')]);
  assert.equal(r2.count, 1);
  assert.deepEqual(r2.permutation, ['a', 'b']);
  assert.equal(r2.winners[0].ruleIndex, 0);
});

test('层顺序规划：无层声明仍参与层叠（普通声明无层 > 有层，与排列无关）', () => {
  const html = '<p>x</p>';
  const rules = [
    R('p', 'color', 'red'),                   // 0 无层
    R('p', 'color', 'blue', { layer: 'a' }),  // 1
  ];
  // 无层 red 恒胜出：任何排列都满足 → 1! = 1 个排列
  const r = plan(html, rules, [T('0', 'color', 'red')]);
  assert.equal(r.count, 1);
  assert.equal(r.totalPermutations, 1);
  assert.deepEqual(r.permutation, ['a']);
  assert.equal(r.winners[0].ruleIndex, 0);
  // 目标 blue：固定胜者不等于目标 → 无解且是单目标不可达
  const r2 = plan(html, rules, [T('0', 'color', 'blue')]);
  assert.equal(r2.count, 0);
  assert.equal(r2.permutation, null);
  assert.equal(r2.impossibleTarget, 0);
  assert.match(r2.impossibleReason, /与层排列无关/);
});

test('层顺序规划：!important 有层 > 无层，无层 important 仅在没有有层时胜出', () => {
  const html = '<p>x</p>';
  const rules = [
    R('p', 'color', 'unlayered-imp', { important: true }),   // 0
    R('p', 'color', 'layered-imp', { layer: 'a', important: true }), // 1
  ];
  // 有层 important 压制无层 important → 目标 unlayered-imp 无解
  const r = plan(html, rules, [T('0', 'color', 'unlayered-imp')]);
  assert.equal(r.count, 0);
  assert.equal(r.impossibleTarget, 0);
  const r2 = plan(html, rules, [T('0', 'color', 'layered-imp')]);
  assert.equal(r2.count, 1);
  assert.equal(r2.winners[0].ruleIndex, 1);
});

test('层顺序规划：无声明目标（value 为 null）', () => {
  const html = '<div><p>x</p></div>';
  const rules = [R('p', 'color', 'red', { layer: 'a' })];
  // div 上 color 无任何匹配声明 → 满足
  const r = plan(html, rules, [T('0', 'color', null)]);
  assert.equal(r.count, 1);
  assert.equal(r.winners[0], null);
  // p 上有匹配声明 → 不可能无声明
  const r2 = plan(html, rules, [T('0.0', 'color', null)]);
  assert.equal(r2.count, 0);
  assert.equal(r2.impossibleTarget, 0);
  assert.match(r2.impossibleReason, /无声明/);
  // 无匹配声明却要求具体值 → 无解
  const r3 = plan(html, rules, [T('0', 'color', 'red')]);
  assert.equal(r3.count, 0);
  assert.match(r3.impossibleReason, /没有任何匹配声明/);
});

test('层顺序规划：无命名层算一个空排列', () => {
  const html = '<p>x</p>';
  const rules = [R('p', 'color', 'red')];
  const r = plan(html, rules, [T('0', 'color', 'red')]);
  assert.equal(r.count, 1);
  assert.equal(r.totalPermutations, 1);
  assert.deepEqual(r.permutation, []);
  assert.deepEqual(r.permutationNumbers, []);
  assert.equal(r.winners[0].ruleIndex, 0);
  // 值不匹配则唯一空排列也不可行
  const r2 = plan(html, rules, [T('0', 'color', 'blue')]);
  assert.equal(r2.count, 0);
});

test('层顺序规划：值按字符串精确比较', () => {
  const html = '<p>x</p>';
  const rules = [R('p', 'color', 'red', { layer: 'a' })];
  assert.equal(plan(html, rules, [T('0', 'color', 'RED')]).count, 0);
  assert.equal(plan(html, rules, [T('0', 'color', ' red')]).count, 0);
  assert.equal(plan(html, rules, [T('0', 'color', 'red ')]).count, 0);
  assert.equal(plan(html, rules, [T('0', 'color', 'red')]).count, 1);
});

test('层顺序规划：同层内仍比较特异性与原规则顺序', () => {
  const html = '<p class="a">x</p>';
  const rules = [
    R('p', 'color', 'low', { layer: 'a' }),    // 0 同层特异性低
    R('.a', 'color', 'high', { layer: 'a' }),  // 1 同层特异性高 → 层 a 的组内冠军
    R('p', 'color', 'other', { layer: 'b' }),  // 2
  ];
  // 层 a 的胜出值是 high：目标 high 要求 a 在 b 之后
  const r = plan(html, rules, [T('0', 'color', 'high')]);
  assert.equal(r.count, 1);
  assert.deepEqual(r.permutation, ['b', 'a']);
  assert.equal(r.winners[0].ruleIndex, 1);
  // 目标 low 不可达（同层内被 .a 压制，与排列无关）
  const r2 = plan(html, rules, [T('0', 'color', 'low')]);
  assert.equal(r2.count, 0);
  assert.equal(r2.impossibleTarget, 0);
});

test('层顺序规划：所有命名层均参与排列，字典序最小', () => {
  const html = '<p class="x">x</p>';
  const rules = [
    R('.x', 'color', 'va', { layer: 'a' }),  // 0 → 层 a 编号 1
    R('.x', 'color', 'vb', { layer: 'b' }),  // 1 → 层 b 编号 2
    R('span', 'color', 'vc', { layer: 'c' }), // 2 → 层 c 编号 3（与目标无关，仍参与排列）
  ];
  // 目标 va：last({a,b}) = a → a 在 b 后即可，c 任意 → 3 个可行排列
  const r = plan(html, rules, [T('0', 'color', 'va')]);
  assert.equal(r.count, 3);
  assert.equal(r.totalPermutations, 6);
  // 编号序列字典序最小：[b, a, c] = [2, 1, 3]
  assert.deepEqual(r.permutation, ['b', 'a', 'c']);
  assert.deepEqual(r.permutationNumbers, [2, 1, 3]);
  assert.equal(r.winners[0].ruleIndex, 0);
});

test('层顺序规划：多目标约束组合与冲突', () => {
  const html = '<p class="a">x</p><p class="b">y</p>';
  const rules = [
    R('.a', 'color', 'red', { layer: 'a' }),   // 0
    R('.a', 'color', 'blue', { layer: 'b' }),  // 1
    R('.b', 'color', 'red', { layer: 'a' }),   // 2
    R('.b', 'color', 'blue', { layer: 'b' }),  // 3
  ];
  // 两个目标同向：都要 a 在后 → 可行
  const r = plan(html, rules, [T('0', 'color', 'red'), T('1', 'color', 'red')]);
  assert.equal(r.count, 1);
  assert.deepEqual(r.permutation, ['b', 'a']);
  assert.deepEqual(r.winners.map((w) => w.ruleIndex), [0, 2]);
  // 两个目标冲突：目标 1 要 a 在后、目标 2 要 b 在后 → 无解（各自可达但组合冲突）
  const r2 = plan(html, rules, [T('0', 'color', 'red'), T('1', 'color', 'blue')]);
  assert.equal(r2.count, 0);
  assert.equal(r2.impossibleTarget, -1);
  assert.equal(r2.winners, null);
});

test('层顺序规划：important 与普通目标混合约束', () => {
  const html = '<p class="a">x</p><p class="b">y</p>';
  const rules = [
    R('.a', 'color', 'imp-a', { layer: 'a', important: true }), // 0
    R('.a', 'color', 'imp-b', { layer: 'b', important: true }), // 1
    R('.b', 'color', 'nor-a', { layer: 'a' }),                  // 2
    R('.b', 'color', 'nor-b', { layer: 'b' }),                  // 3
  ];
  // 目标 1（important）：first({a,b}) = a；目标 2（普通）：last({a,b}) = a
  // → a 既要最前又要最后，仅当……不可能（两层时 a 不能同时在 b 前后）→ 无解
  const conflict = plan(html, rules, [T('0', 'color', 'imp-a'), T('1', 'color', 'nor-a')]);
  assert.equal(conflict.count, 0);
  // 目标 1 要 a 最前（imp-a），目标 2 要 b 最后（nor-b）→ 唯一排列 [a, b]
  const r = plan(html, rules, [T('0', 'color', 'imp-a'), T('1', 'color', 'nor-b')]);
  assert.equal(r.count, 1);
  assert.deepEqual(r.permutation, ['a', 'b']);
  assert.deepEqual(r.winners.map((w) => w.ruleIndex), [0, 3]);
});

/* 与暴力枚举全排列交叉验证（独立的层叠比较实现）。 */
function bruteForcePlan(html, rules, targets) {
  const { roots } = parseHtml(html);
  const { compiled, layerOrder } = compileRules(rules);
  const n = layerOrder.length;
  const cmp = (a, b) => {
    if (a.important !== b.important) return a.important ? 1 : -1;
    const ra = a.layer === null ? Infinity : a.layerIdx;
    const rb = b.layer === null ? Infinity : b.layerIdx;
    if (ra !== rb) return (a.important ? ra < rb : ra > rb) ? 1 : -1;
    for (let k = 0; k < 3; k++) {
      if (a.specificity[k] !== b.specificity[k]) return a.specificity[k] > b.specificity[k] ? 1 : -1;
    }
    return a.order > b.order ? 1 : -1;
  };
  const okPerms = [];
  const cur = [];
  const used = new Array(n).fill(false);
  const gen = () => {
    if (cur.length === n) {
      const rank = new Map(cur.map((li, r) => [layerOrder[li], r]));
      const ok = targets.every((t) => {
        const node = findByPath(roots, t.path);
        const decls = compiled.filter((d) => d.property === t.property && matchesSelector(node, d.parsed));
        if (!decls.length) return t.value === null;
        if (t.value === null) return false;
        let best = null;
        for (const d of decls) {
          const dd = d.layer === null ? d : { ...d, layerIdx: rank.get(d.layer) };
          if (!best || cmp(dd, best) > 0) best = dd;
        }
        return best.value === t.value;
      });
      if (ok) okPerms.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      gen();
      cur.pop();
      used[i] = false;
    }
  };
  gen();
  return okPerms;
}

test('层顺序规划：与暴力枚举全排列结果一致（确定性伪随机用例）', () => {
  // 简单 LCG，保证用例可复现
  let seed = 20260927;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const layers = ['a', 'b', 'c', 'd'];
  const sels = ['p', '.x', 'p.x', '#m p', 'div .x'];
  const props = ['color', 'background-color', 'font-size'];
  const values = ['red', 'blue', 'green', '12px', '1em'];

  for (let round = 0; round < 60; round++) {
    const html = '<div id="m"><p class="x">t</p><p>u</p></div>';
    const ruleCount = 2 + Math.floor(rnd() * 5); // 2～6 条
    const rules = [];
    for (let i = 0; i < ruleCount; i++) {
      rules.push(R(pick(sels), pick(props), pick(values), {
        layer: rnd() < 0.7 ? pick(layers) : '',
        important: rnd() < 0.3,
      }));
    }
    const targetCount = 1 + Math.floor(rnd() * 3); // 1～3 项目标
    const targets = [];
    for (let i = 0; i < targetCount; i++) {
      targets.push(T(pick(['0', '0.0', '0.1']), pick(props), rnd() < 0.2 ? null : pick(values)));
    }
    const { roots } = parseHtml(html);
    const got = planLayerOrder(roots, rules, targets);
    const expected = bruteForcePlan(html, rules, targets);
    assert.equal(got.count, expected.length, `第 ${round} 轮计数不一致：${JSON.stringify({ rules, targets })}`);
    if (!expected.length) {
      assert.equal(got.permutation, null);
      continue;
    }
    // 字典序最小（按层首次出现编号）的可行排列
    const bestIdx = expected.reduce((best, p) => {
      for (let i = 0; i < p.length; i++) {
        if (p[i] !== best[i]) return p[i] < best[i] ? p : best;
      }
      return best;
    });
    const { layerOrder } = compileRules(rules);
    assert.deepEqual(got.permutation, bestIdx.map((i) => layerOrder[i]),
      `第 ${round} 轮最优排列不一致：${JSON.stringify({ rules, targets })}`);
    assert.deepEqual(got.permutationNumbers, bestIdx.map((i) => i + 1));
    // 各目标胜出规则确实满足目标
    targets.forEach((t, i) => {
      if (t.value === null) assert.equal(got.winners[i], null);
      else assert.equal(got.winners[i].value, t.value);
    });
  }
});

test('层顺序规划：规模上限常量', () => {
  assert.equal(LAYER_PLAN_MAX_ELEMENTS, 40);
  assert.equal(LAYER_PLAN_MAX_RULES, 60);
  assert.equal(LAYER_PLAN_MAX_LAYERS, 12);
  assert.equal(LAYER_PLAN_MAX_TARGETS, 8);
});

console.log(`\n全部 ${passed} 项测试通过。`);