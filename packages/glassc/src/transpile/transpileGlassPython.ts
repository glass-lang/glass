import { parseGlassBlocks, removeGlassComments } from '@glass-lang/glasslib'
import camelcase from 'camelcase'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseGlassAST } from '../parse/parseGlassAST.js'
import { parseGlassTopLevelJsxElements } from '../parse/parseGlassTopLevelJsxElements.js'
import { removeGlassFrontmatter } from '../transform/removeGlassFrontmatter.js'
import { transformDynamicBlocksPython } from '../transform/transformDynamicBlocksPython.js'
import { getGlassExportName } from './transpileGlass.js'

const extension = 'glass'

/**
 * Takes a .glass document and returns a code file.
 * The directory / folder information is necessary so we can correctly re-write import paths.
 * The language is necessary so we can correctly format the output. Currently only supports 'typescript'.
 */
export function transpileGlassFilePython(
  doc: string,
  {
    workspaceFolder,
    folderPath,
    outputDirectory,
    fileName,
    language,
  }: { workspaceFolder: string; folderPath: string; outputDirectory: string; fileName: string; language: string }
) {
  const originalDoc = doc

  const toplevelNodes = parseGlassTopLevelJsxElements(originalDoc)

  // first, parse the document blocks to make sure the document is valid
  // this will also tell us if there are any special (e.g. <Code>) blocks that should appear unmodified in the final output
  const blocks = parseGlassBlocks(doc)
  // if (blocks.length === 0) {
  //   throw new Error(`No blocks found in ${fileName}.${extension}, did you mean to add a <Prompt> block?`)
  // }

  const codeBlocks = blocks.filter(b => b.tag === 'Code')

  // remove all block comments before any processing happens
  doc = removeGlassComments(doc)
  const functionName = camelcase(fileName)
  const exportName = getGlassExportName(fileName)

  const hasPrompt = toplevelNodes.filter(node => node.tagName === 'Prompt').length > 0
  const isChat = !hasPrompt

  const { imports, jsxExpressions } = parseGlassAST(doc, {
    workspaceFolder,
    folderPath,
    outputDirectory,
    fileName,
  })

  // all variables inside {} are interpolation variables, including ones like {foo.bar}
  // const allInterpolationVars = Object.keys(interpolationArgs)

  // const interpolationVarNames = Array.from(new Set<string>(allInterpolationVars.map(arg => arg.split('.')[0])))

  let argsNode = ''

  let model = isChat ? 'gpt-3.5-turbo' : 'text-davinci-003'

  // find all the interpolation variables from dynamic code blocks
  for (const jsxNode of toplevelNodes) {
    if (jsxNode.tagName === 'Args') {
      argsNode = originalDoc.substring(jsxNode.position.start.offset, jsxNode.position.end.offset)
    }
    if (jsxNode.tagName === 'Code') {
      // don't strip away codeblocks, yet
      // doc = doc.substring(0, jsxNode.position.start.offset) + doc.substring(jsxNode.position.end.offset)
      continue // ignore all interpolation sequences / requirements in code blocks
    }
    if (jsxNode.tagName === 'Chat' || jsxNode.tagName === 'Completion') {
      const modelAttr = jsxNode.attrs.find(a => a.name === 'model')
      // value is either <Chat model="gpt-3.5-turbo" /> or <Chat model={"gpt-4"} />
      // we don't currently support dynamic model values
      model = modelAttr ? modelAttr.stringValue || JSON.parse(modelAttr.expressionValue!) : model
      continue
    }
    // if (builtinTags.has(jsxNode.tagName)) {
    //   continue
    // }
  }

  const dynamicTransform = transformDynamicBlocksPython(doc)
  doc = dynamicTransform.doc

  // look inside the transformedDoc for any sequence like:
  // ${...} (allowing for whitespace / multiple lines), or
  // !##GLASS-[0-9]+
  //
  // replace all of these with a Python format argument {} and add the
  // corresponding value to the formatArgs array
  const regex = /\$\{(.+?)\}/gs
  let match: RegExpExecArray | null

  let finalDoc = doc
  const formatArgs: string[] = []

  while ((match = regex.exec(doc)) != null) {
    formatArgs.push(match[1])
    finalDoc = finalDoc.replace(match[0], '{}')
  }

  // remove frontmatter after parsing the AST
  finalDoc = removeGlassFrontmatter(finalDoc)

  const codeSanitizedDoc = finalDoc
  const codeInterpolationMap: any = { ...dynamicTransform.jsxInterpolations }

  // iterate over all the jsxExpressions (values inside `{ }`) and replace them with a number if they're supposed to be treated like code (values inside `${ }`)

  // for (let j = 0; j < jsxExpressions.length; j++) {
  //   const expr = jsxExpressions[j]

  //   const codeInterpolation = '${' + expr + '}'
  //   const indexOfInterpolation = codeSanitizedDoc.indexOf(codeInterpolation)
  //   if (indexOfInterpolation === -1) {
  //     continue
  //   }
  //   // codeSanitizedDoc = codeSanitizedDoc.replace(codeInterpolation, `\${${j}}`)
  //   if (expr.trim().startsWith('async')) {
  //     codeSanitizedDoc = codeSanitizedDoc.replace(codeInterpolation, `\${await (${expr.trim()})()}`)
  //     // codeInterpolationMap['' + j] = `await (${expr.trim()})()`
  //   } else if (expr.trim().startsWith('function')) {
  //     codeSanitizedDoc = codeSanitizedDoc.replace(codeInterpolation, `\${(${expr.trim()})()}`)
  //     // codeInterpolationMap['' + j] = `(${expr.trim()})()`
  //   } else {
  //     codeSanitizedDoc = codeSanitizedDoc.replace(codeInterpolation, `\${${expr.trim()}}`)
  //     // codeInterpolationMap['' + j] = expr.trim()
  //   }
  // }

  // after interpolating everything, we can unescape `\{ \}` sequences
  // codeSanitizedDoc = unescapeGlass(codeSanitizedDoc)

  const undeclaredVars = dynamicTransform.undeclaredSymbols.map(s => `${s} = opt["args"]["${s}"]`).join('\n    ')

  let codeStart = ''
  if (undeclaredVars) {
    codeStart = codeStart ? codeStart + undeclaredVars + '\n' : '\n    ' + undeclaredVars
  }
  if (codeBlocks.length) {
    codeStart = codeStart
      ? codeStart + codeBlocks.map(b => b.content).join('\n') + '\n'
      : '\n    ' + codeBlocks.map(b => b.content).join('\n')
  }

  const glassvar =
    Object.keys(codeInterpolationMap).length === 0
      ? 'GLASSVAR = {}'
      : 'GLASSVAR = {\n        ' +
        Object.keys(codeInterpolationMap)
          .map(k => `${k}: ${codeInterpolationMap[k]}`)
          .join(',\n        ') +
        '\n    }'

  const code = `${imports.join('\n')}

def ${exportName}(opt):${codeStart}
    ${glassvar}
    return """${finalDoc}""".format(${formatArgs.join(', ')})`

  return {
    code: code.trim(),
    args: [],
    imports,
    functionName,
    exportName,
    variableNames: dynamicTransform.undeclaredSymbols,
  }
}

/**
 * Takes a path, either to a file or a folder, and transpiles all glass files in that folder, or the file specified.
 */
export function transpileGlassPython(
  workspaceFolder: string,
  fileOrFolderPath: string,
  language: string,
  outputDirectory: string
) {
  const functions = transpileGlassHelper(workspaceFolder, fileOrFolderPath, language, outputDirectory)
  return constructGlassOutputFilePython(functions)
}

export function constructGlassOutputFilePython(functions: ReturnType<typeof transpileGlassHelper>) {
  const functionsString = functions.map(f => f.code).join('\n\n')

  const code = `# THIS FILE WAS GENERATED BY GLASS -- DO NOT EDIT!

${functionsString}
`

  return code
}

function transpileGlassHelper(
  workspaceFolder: string,
  fileOrFolderPath: string,
  language: string,
  outputDirectory: string
): {
  code: string
  args: {
    name: string
    type: string
    description?: string | undefined
    optional?: boolean | undefined
  }[]
  imports: string[]
  functionName: string
  exportName: string
}[] {
  const file = fileOrFolderPath.split('/').slice(-1)[0]
  const folderPath = fileOrFolderPath.split('/').slice(0, -1).join('/')
  if (fs.statSync(fileOrFolderPath).isDirectory()) {
    // Recursively process files in subdirectory
    return recursiveCodegen(workspaceFolder, fileOrFolderPath, language, outputDirectory)
  } else if (path.extname(file) === `.${extension}`) {
    const fileContent = fs.readFileSync(fileOrFolderPath, 'utf8')
    const fileName = path.basename(file, `.${extension}`)

    // const newFileName = `${fileName}.ts` // TODO: allow other languages
    // const newFilePath = path.join(folderPath, newFileName)

    // Transpile the glass file to the target language.
    const codegenedResult = transpileGlassFilePython(fileContent, {
      workspaceFolder,
      folderPath,
      fileName,
      language,
      outputDirectory,
    })
    if (!codegenedResult) {
      return []
    }
    return [codegenedResult]
    // fs.writeFileSync(newFilePath, code)
  } else {
    // not a glass file
    return []
  }
}
function recursiveCodegen(workspaceFolder: string, folderPath: string, language: string, outputDirectory: string) {
  const files = fs.readdirSync(folderPath)
  const functions: any = []
  for (const file of files) {
    const filePath = path.join(folderPath, file)
    functions.push(...transpileGlassHelper(workspaceFolder, filePath, language, outputDirectory))
  }
  return functions
}