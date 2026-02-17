const fs = require('fs');
const path = require('path');

console.log('🚀 开始部署...');

try {
  // 1. 读取 openai.html 的全部内容
  const htmlPath = path.join(__dirname, 'openai.html');
  console.log('📖 读取 HTML 文件:', htmlPath);

  if (!fs.existsSync(htmlPath)) {
    throw new Error('openai.html 文件不存在');
  }

  const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
  console.log('✅ HTML 文件读取成功，大小:', htmlContent.length, '字符');

  // 1.5. 内联 CSS 文件
  console.log('🎨 处理 CSS 内联...');
  let processedHtml = htmlContent;

  // 匹配 <link rel="stylesheet" href="style.css" />
  const cssLinkRegex = /<link\s+rel="stylesheet"\s+href="style\.css"\s*\/?>/i;

  if (cssLinkRegex.test(processedHtml)) {
    // 读取 style.css 文件
    const cssPath = path.join(__dirname, 'style.css');
    console.log('📖 读取 CSS 文件:', cssPath);

    if (!fs.existsSync(cssPath)) {
      throw new Error('style.css 文件不存在');
    }

    let cssContent = fs.readFileSync(cssPath, 'utf-8');
    // 在每一行开头添加6个空格
    cssContent = cssContent
      .split('\n')
      .map(line => '      ' + line)
      .join('\n');
    console.log('✅ CSS 文件读取成功，大小:', cssContent.length, '字符');

    // 替换 link 标签为 style 标签
    processedHtml = processedHtml.replace(
      cssLinkRegex,
      `<style>\n${cssContent}\n</style>`
    );
    console.log('✅ CSS 内联完成');
  } else {
    console.log('ℹ️  未找到 style.css 链接，跳过 CSS 内联');
  }

  // 2. 读取 worker.js 文件
  const workerPath = path.join(__dirname, '..', 'worker.js');
  console.log('📖 读取 worker.js 文件:', workerPath);

  if (!fs.existsSync(workerPath)) {
    throw new Error('worker.js 文件不存在');
  }

  const workerContent = fs.readFileSync(workerPath, 'utf-8');
  console.log('✅ worker.js 文件读取成功，大小:', workerContent.length, '字符');

  // 2.5. 转义 HTML 内容用于模板字符串
  console.log('🔒 转义 HTML 内容用于模板字符串...');
  processedHtml = processedHtml
    .replace(/\\/g, '\\\\') // 先转义反斜杠
    .replace(/`/g, '\\`') // 转义反引号
    .replace(/\$/g, '\\$'); // 转义美元符号
  console.log('✅ HTML 内容转义完成');

  // 3. 使用正则替换 htmlContent 部分
  // 匹配模式：let htmlContent = `...任意内容...`; // htmlContent FINISHED
  const regex = /(let htmlContent = `)([\s\S]*?)(`; \/\/ htmlContent FINISHED)/;

  if (!regex.test(workerContent)) {
    throw new Error('在 worker.js 中未找到 htmlContent 标记');
  }

  console.log('🔄 替换 HTML 内容...');
  const newWorkerContent = workerContent.replace(
    regex,
    (match, prefix, oldContent, suffix) => {
      console.log(
        '💡 找到 htmlContent 标记，原内容长度:',
        oldContent.length,
        '字符'
      );
      // 不做任何转义，直接使用原始内容
      return prefix + processedHtml + suffix;
    }
  );

  // 4. 写回 worker.js 文件
  console.log('💾 写入更新后的 worker.js...');
  fs.writeFileSync(workerPath, newWorkerContent, 'utf-8');

  console.log('✨ 部署完成！');
  console.log('📊 统计信息:');
  console.log('   - HTML 内容长度:', processedHtml.length, '字符');
  console.log('   - worker.js 总长度:', newWorkerContent.length, '字符');
} catch (error) {
  console.error('❌ 部署失败:', error.message);
  process.exit(1);
}
