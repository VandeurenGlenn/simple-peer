// import modify from 'rollup-plugin-modify';
import typescript from '@rollup/plugin-typescript'
import rimraf from 'rimraf'
import nodeResolve from '@rollup/plugin-node-resolve'

try {
  rimraf.sync('./exports/*.js')
} catch (e) {
  console.log('nothing to clean')
}

export default [
  {
    input: ['src/index.ts'],
    external: ['@koush/wrtc'],
    output: [
      {
        dir: './exports',
        format: 'es'
      }
    ],
    plugins: [typescript()]
  },
  {
    input: ['src/index.ts'],
    external: ['@koush/wrtc'],
    output: [
      {
        dir: './exports/browser',
        format: 'es'
      }
    ],
    plugins: [
      nodeResolve(),
      typescript({
        compilerOptions: {
          outDir: './exports/browser',
          declaration: false
        }
      })
    ]
  }
]
