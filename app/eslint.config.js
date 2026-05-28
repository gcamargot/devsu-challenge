import js from '@eslint/js'
import globals from 'globals'

export default [
    {
        ignores: ['coverage/**', 'node_modules/**'],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.jest,
            },
        },
        rules: {
            'no-unused-vars': ['error', { caughtErrors: 'none', argsIgnorePattern: '^_' }],
        },
    },
]
