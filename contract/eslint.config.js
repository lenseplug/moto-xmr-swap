// @ts-check
// ESLint flat config for OPNet AssemblyScript smart contracts
// AssemblyScript uses compile-time globals (ABIDataTypes, @method, @returns, @emit)
// that are injected by opnet-transform. TypeScript/ESLint cannot resolve them,
// so unsafe-access rules are disabled.

import tseslint from 'typescript-eslint';
import eslint from '@eslint/js';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            parserOptions: {
                ecmaFeatures: {
                    experimentalDecorators: true,
                },
            },
        },
        rules: {
            'no-undef': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-empty': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/only-throw-error': 'off',
            '@typescript-eslint/no-unnecessary-condition': 'off',
            '@typescript-eslint/no-confusing-void-expression': 'off',
            '@typescript-eslint/no-extraneous-class': 'off',
            '@typescript-eslint/restrict-plus-operands': 'off',
            '@typescript-eslint/no-unnecessary-type-assertion': 'off',
            '@typescript-eslint/no-unnecessary-type-parameters': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-explicit-any': 'error',
            'no-loss-of-precision': 'off',
            'no-bitwise': 'off',

            // Ban floating point types in contracts
            'no-restricted-syntax': [
                'error',
                {
                    selector: "TSTypeReference[typeName.name=/^(f32|f64|Float32Array|Float64Array)$/]",
                    message: 'Floating-point types are prohibited in OPNet contracts. Use u128/u256 for all arithmetic.',
                },
            ],
        },
    },
    {
        files: ['**/*.js'],
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
);
