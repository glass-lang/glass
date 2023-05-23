import { constructGlassOutputFileNext, getGlassExportName, transpileGlassFileNext } from '@glass-lang/glassc'
import { runGlass } from '@glass-lang/glasslib'
import * as esbuild from 'esbuild'
import fs from 'fs'
import fetch from 'node-fetch'
import path from 'path'
import { TextDecoder } from 'util'
import vm from 'vm'
import * as vscode from 'vscode'
import { executeGlassFilePython } from './executeGlassFilePython'
import { getDocumentFilename } from './util/isGlassFile'
import { getAnthropicKey, getOpenaiKey } from './util/keys'

export async function executeGlassFile(
  document: vscode.TextDocument,
  interpolationArgs: any,
  usePython: boolean,
  progress?: (data: { nextDoc: string; rawResponse?: string }) => void
) {
  const fileName = getDocumentFilename(document)

  const openaiKey = getOpenaiKey()
  const anthropicKey = getAnthropicKey()

  const c = usePython
    ? await executeGlassFilePython(document, interpolationArgs)
    : await executeTypescript(document, fileName, interpolationArgs)

  return await runGlass(c, { openaiKey: openaiKey || '', anthropicKey: anthropicKey || '', progress })
}

async function executeTypescript(document: vscode.TextDocument, fileName: string, interpolationArgs: any) {
  const activeEditorWorkspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (!activeEditorWorkspaceFolder) {
    throw new Error('Could not find active editor workspace folder')
  }

  const outputDirectoryConfig: string = vscode.workspace.getConfiguration('glass').get('outputDirectory') as any

  const workspacePath = activeEditorWorkspaceFolder.uri.fsPath
  const outDir = outputDirectoryConfig.replace('${workspaceFolder}', workspacePath)

  const transpiledFunction = transpileGlassFileNext(document.getText(), {
    workspaceFolder: workspacePath,
    folderPath: document.uri.fsPath.split('/').slice(0, -1).join('/'),
    fileName,
    language: 'typescript',
    outputDirectory: outDir,
  })
  const transpiledCode = constructGlassOutputFileNext([transpiledFunction])

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir)
  }
  const tmpFilePath = path.join(outDir, 'glass-tmp.ts')

  fs.writeFileSync(
    tmpFilePath,
    `${transpiledCode}
context.response = ${getGlassExportName(fileName)}({ args: ${JSON.stringify(
      interpolationArgs
    )}, options: { openaiKey: OPENAI_API_KEY, anthropicKey: ANTHROPIC_API_KEY, progress } })`,
    {
      encoding: 'utf-8',
    }
  )

  // bundle the code so that it can be executed in a vm with resolved imports
  const result = await esbuild.build({
    entryPoints: [tmpFilePath],
    bundle: true,
    platform: 'node',
    write: false,
    format: 'cjs',
    target: 'es2020',
    external: ['@glass-lang/glasslib'],
  })

  const bundledCode = new TextDecoder().decode(result.outputFiles[0].contents)

  fs.unlinkSync(tmpFilePath)

  const script = new vm.Script(bundledCode, { filename: 'outputFile.js' })

  const context: any = {}

  const ctx = {
    console,
    context,
    global,
    process,
    module: { exports: {} },
    require: require,
    __filename: 'outputFile.js',
    fetch,
  }

  vm.createContext(ctx)
  script.runInContext(ctx)

  const { getTestData, compile } = context.response

  const t = getTestData()
  const c = await compile(t)
  return c
}
