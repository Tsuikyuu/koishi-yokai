import eslint from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/lib/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/*.tsbuildinfo',
      'external/**',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.{1,2}/.*\\.js(?:[?#].*)?$',
              message:
                'Use an extensionless relative specifier so TypeScript source loaders can resolve the module.',
            },
          ],
        },
      ],
      'no-param-reassign': [
        'error',
        {
          props: true,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "TSAsExpression:not([typeAnnotation.typeName.name='const'])",
          message:
            'Type assertions are prohibited. Use a constructor, parser, type guard, or explicit data structure.',
        },
        {
          selector: 'TSTypeAssertion',
          message:
            'Angle-bracket type assertions are prohibited. Use a constructor, parser, type guard, or explicit data structure.',
        },
        {
          selector: 'ChainExpression',
          message:
            'Optional chaining is prohibited. Handle the missing value with an explicit branch, Option, or pattern matching.',
        },
        {
          selector: 'TSUnknownKeyword',
          message:
            'Explicit unknown is prohibited. Parse boundary input into a precise type or an explicit error.',
        },
        {
          selector: 'PropertyDefinition[definite=true], VariableDeclarator[definite=true]',
          message:
            'Definite assignment assertions are prohibited. Initialize the value or model its absence explicitly.',
        },
        {
          selector:
            'ImportExpression[source.value=/^\\.{1,2}\\/.*\\.js(?:[?#].*)?$/], TSImportType[source.value=/^\\.{1,2}\\/.*\\.js(?:[?#].*)?$/]',
          message:
            'Use an extensionless relative specifier so TypeScript source loaders can resolve the module.',
        },
        {
          selector:
            "ImportExpression[source.type='TemplateLiteral'][source.expressions.length=0][source.quasis.0.value.cooked=/^\\.{1,2}\\/.*\\.js(?:[?#].*)?$/]",
          message:
            'Use an extensionless relative specifier so TypeScript source loaders can resolve the module.',
        },
      ],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  eslintConfigPrettier,
)
