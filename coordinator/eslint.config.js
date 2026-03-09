// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigDirName: import.meta.dirname,
            },
        },
        rules: {
            'no-undef': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-empty': 'off',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/only-throw-error': 'off',
            '@typescript-eslint/no-unnecessary-condition': 'off',
            '@typescript-eslint/unbound-method': 'warn',
            '@typescript-eslint/no-confusing-void-expression': 'off',
            '@typescript-eslint/no-extraneous-class': 'off',
            'no-async-promise-executor': 'off',
            '@typescript-eslint/no-misused-promises': 'off',
            '@typescript-eslint/no-unnecessary-type-parameters': 'off',
            '@typescript-eslint/no-duplicate-enum-values': 'off',
            'prefer-spread': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/no-base-to-string': 'off',
            '@typescript-eslint/no-dynamic-delete': 'off',
            '@typescript-eslint/no-redundant-type-constituents': 'off',
            'no-useless-assignment': 'off',
            'no-restricted-globals': [
                'error',
                {
                    name: 'Buffer',
                    message:
                        'Buffer is REMOVED from OPNet. Use Uint8Array with BufferHelper from @btc-vision/transaction.',
                },
            ],
            'no-restricted-properties': [
                'error',
                {
                    object: 'Buffer',
                    property: 'from',
                    message: 'Buffer is REMOVED. Use BufferHelper.fromHex() or new TextEncoder().encode().',
                },
                {
                    object: 'Buffer',
                    property: 'alloc',
                    message: 'Buffer is REMOVED. Use new Uint8Array(size).',
                },
                {
                    object: 'Buffer',
                    property: 'concat',
                    message: 'Buffer is REMOVED. Use Uint8Array concatenation.',
                },
            ],
        },
    },
    {
        files: ['**/*.js'],
        ...tseslint.configs.disableTypeChecked,
    },
);
