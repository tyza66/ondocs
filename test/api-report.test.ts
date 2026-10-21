// The public API, entry by entry, as a report kept next to the tests: every export with its
// signature, and every option type with its properties. A change to what the package exports, or
// to the name or type of an option, changes test/__snapshots__/api-report.txt, so it shows in
// review: accept it with `pnpm vitest run test/api-report.test.ts -u`. CI fails when the report
// is out of date, as it never writes snapshots.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');

/** Each import of the package that has types, and the source its types are built from. */
const ENTRIES: Record<string, string> = {
  ondocs: 'src/index.ts',
  'ondocs/node': 'src/node/index.ts',
  'ondocs/integration': 'src/integration/index.ts',
  'ondocs/server': 'src/server/index.ts',
  'ondocs/react': 'src/react/index.ts',
  'ondocs/mock': 'src/mock/index.ts',
  // ondocs/embed/standalone has the same types.
  'ondocs/embed': 'src/embed/index.ts',
  'ondocs/docusaurus': 'src/docusaurus/index.ts',
  'ondocs/astro': 'src/astro/index.ts',
  'ondocs/astro/ask-route': 'src/astro/ask-route.ts',
  'ondocs/astro/mcp-route': 'src/astro/mcp-route.ts',
  'ondocs/starlight': 'src/starlight/index.ts',
  'ondocs/vitepress': 'src/vitepress/index.ts',
};

/**
 * The exports that may still change in a minor version before 1.0, which the Package API page
 * lists under "Experimental": the search's building blocks, whose output follows the search as it
 * improves, and the plugins' plumbing in ondocs/integration.
 */
const EXPERIMENTAL: Record<string, readonly string[]> = {
  ondocs: [
    'Bm25Index',
    'Bm25Options',
    'Bm25Result',
    'CHUNKER_VERSION',
    'chunkSearchText',
    'cosineSimilarity',
    'decodeBase64',
    'decodeVector',
    'embeddingSettingsKey',
    'encodeBase64',
    'encodeVector',
    'FusedResult',
    'quantizeInt8',
    'reciprocalRankFusion',
    'tokenize',
    'VectorIndex',
  ],
  'ondocs/integration': [
    'checkOptions',
    'consoleLogger',
    'excluder',
    'hintDevEndpoint',
    'OptionRule',
    'OptionRules',
    'OptionRuleSet',
    'optionRules',
    'OptionShapeExtras',
    'quietUseClient',
    'warnMissingDialogPeers',
  ],
};

/** How types are written: whole, with single quotes, and lists as `Array<T>`. */
const FORMAT =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType |
  ts.TypeFormatFlags.WriteArrayAsGenericType;

/** One line of a type or a signature, without the source's line breaks. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The API of every entry, as text. */
function apiReport(): string {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), (path) => ts.sys.readFile(path));
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(
    Object.values(ENTRIES).map((file) => join(root, file)),
    options,
  );
  const checker = program.getTypeChecker();

  const typeText = (type: ts.Type, flags = ts.TypeFormatFlags.None): string =>
    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- flags combine with |
    oneLine(checker.typeToString(type, undefined, FORMAT | flags));
  const printer = ts.createPrinter({ removeComments: true });
  /**
   * A type as the source writes it, without its comments: the order of a union's members as
   * written, which `typeToString` would give in the order TypeScript first met each type.
   */
  const written = (node: ts.TypeNode): string =>
    oneLine(printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()));
  /**
   * `<T>(name: Type, …): Return`. A destructured parameter is written `{…}`, so renaming a local
   * binding does not change the report.
   */
  const signatureText = (signature: ts.Signature): string => {
    const typeParameters = signature.getTypeParameters() ?? [];
    const generics =
      typeParameters.length === 0
        ? ''
        : `<${typeParameters
            .map((parameter) => {
              const constraint = parameter.getConstraint();
              return `${parameter.symbol.name}${constraint ? ` extends ${typeText(constraint)}` : ''}`;
            })
            .join(', ')}>`;
    const parameters = signature.getParameters().map((parameter) => {
      const declaration = parameter.valueDeclaration;
      if (!declaration || !ts.isParameter(declaration)) {
        return `${parameter.name}: ${typeText(checker.getTypeOfSymbol(parameter))}`;
      }
      const name = ts.isIdentifier(declaration.name) ? declaration.name.text : '{…}';
      const rest = declaration.dotDotDotToken ? '...' : '';
      const optional = declaration.questionToken || declaration.initializer ? '?' : '';
      const type = declaration.type
        ? written(declaration.type)
        : typeText(checker.getTypeOfSymbol(parameter));
      return `${rest}${name}${optional}: ${type}`;
    });
    const declared = signature.getDeclaration() as ts.SignatureDeclaration | undefined;
    const returns = declared?.type
      ? written(declared.type)
      : typeText(checker.getReturnTypeOfSignature(signature));
    return `${generics}(${parameters.join(', ')}): ${returns}`;
  };
  const deprecated = (symbol: ts.Symbol): string =>
    symbol.getJsDocTags(checker).some((tag) => tag.name === 'deprecated') ? '  // deprecated' : '';
  /** Whether the package declares it, rather than TypeScript's lib or a dependency. */
  const isOwn = (symbol: ts.Symbol): boolean =>
    (symbol.declarations ?? []).some((declaration) => {
      const file = declaration.getSourceFile();
      return !program.isSourceFileDefaultLibrary(file) && !file.fileName.includes('/node_modules/');
    });
  /** ` extends Error`: what a class or an interface of the package extends from elsewhere. */
  const heritage = (symbol: ts.Symbol): string => {
    const bases = (symbol.declarations ?? []).flatMap((declaration) =>
      (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) &&
      declaration.heritageClauses
        ? declaration.heritageClauses.flatMap((clause) =>
            clause.types
              .filter((base) => {
                const type = checker.getTypeAtLocation(base.expression);
                const target = type.getSymbol() ?? checker.getSymbolAtLocation(base.expression);
                return target ? !isOwn(target) : false;
              })
              .map((base) => oneLine(base.getText())),
          )
        : [],
    );
    return bases.length > 0 ? ` extends ${bases.join(', ')}` : '';
  };

  /** A property's type as declared, without the `undefined` an optional one adds. */
  const propertyType = (property: ts.Symbol): string => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (
      declaration &&
      (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) &&
      declaration.type
    ) {
      return written(declaration.type);
    }
    const text = typeText(checker.getTypeOfSymbol(property));
    return property.flags & ts.SymbolFlags.Optional ? text.replace(/ \| undefined$/, '') : text;
  };

  /**
   * The members of an object type, one per line: call and index signatures, then its properties
   * and methods by name, without those it has from TypeScript's lib or a dependency (the
   * `extends` says where they come from).
   */
  const members = (type: ts.Type, indent: string): string[] => {
    const lines: string[] = [];
    for (const signature of type.getCallSignatures()) {
      lines.push(`${indent}${signatureText(signature)}`);
    }
    for (const info of checker.getIndexInfosOfType(type)) {
      lines.push(`${indent}[key: ${typeText(info.keyType)}]: ${typeText(info.type)}`);
    }
    const properties = checker
      .getPropertiesOfType(type)
      .filter((property) => isOwn(property) || !property.declarations?.length)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const property of properties) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      const modifiers = declaration ? ts.getCombinedModifierFlags(declaration) : 0;
      if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
      if (property.name.startsWith('#') || property.name.startsWith('__@')) continue;
      const optional = property.flags & ts.SymbolFlags.Optional ? '?' : '';
      const readonly = modifiers & ts.ModifierFlags.Readonly ? 'readonly ' : '';
      if (property.flags & ts.SymbolFlags.Method) {
        for (const signature of checker.getTypeOfSymbol(property).getCallSignatures()) {
          lines.push(
            `${indent}${property.name}${optional}${signatureText(signature)}${deprecated(property)}`,
          );
        }
        continue;
      }
      lines.push(
        `${indent}${readonly}${property.name}${optional}: ${propertyType(property)}${deprecated(property)}`,
      );
    }
    return lines;
  };

  /** Whether a type is an object to list member by member, rather than to write out whole. */
  const isObject = (type: ts.Type): boolean =>
    type.isIntersection()
      ? type.types.every(isObject)
      : Boolean(type.flags & ts.TypeFlags.Object) &&
        type.getCallSignatures().length === 0 &&
        type.getConstructSignatures().length === 0;

  /** What one export is: its value, its type, or both, as lines. */
  const describeExport = (name: string, exported: ts.Symbol, experimental: boolean): string[] => {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const mark = experimental ? 'experimental ' : '';
    const note = deprecated(symbol);
    const lines: string[] = [];
    if (symbol.flags & ts.SymbolFlags.Class) {
      lines.push(`${mark}class ${name}${heritage(symbol)} {${note}`);
      const constructor = checker.getTypeOfSymbol(symbol);
      for (const signature of constructor.getConstructSignatures()) {
        const parameters = signatureText(signature).replace(/: [^:]*$/, '');
        lines.push(`  constructor${parameters}`);
      }
      lines.push(...members(checker.getDeclaredTypeOfSymbol(symbol), '  '), '}');
      return lines;
    }
    if (symbol.flags & ts.SymbolFlags.Function) {
      for (const signature of checker.getTypeOfSymbol(symbol).getCallSignatures()) {
        lines.push(`${mark}function ${name}${signatureText(signature)}${note}`);
      }
    } else if (symbol.flags & ts.SymbolFlags.Variable) {
      const declaration = symbol.valueDeclaration;
      const type =
        declaration && ts.isVariableDeclaration(declaration) && declaration.type
          ? written(declaration.type)
          : typeText(checker.getTypeOfSymbol(symbol));
      lines.push(`${mark}const ${name}: ${type}${note}`);
    }
    if (symbol.flags & ts.SymbolFlags.Interface) {
      lines.push(`${mark}interface ${name}${heritage(symbol)} {${note}`);
      lines.push(...members(checker.getDeclaredTypeOfSymbol(symbol), '  '), '}');
    } else if (symbol.flags & ts.SymbolFlags.TypeAlias) {
      const type = checker.getDeclaredTypeOfSymbol(symbol);
      const declaration = symbol.declarations?.find(ts.isTypeAliasDeclaration);
      // Another name for a type, as the deprecated names are: the name it stands for.
      if (
        declaration &&
        ts.isTypeReferenceNode(declaration.type) &&
        !declaration.type.typeArguments &&
        !declaration.typeParameters
      ) {
        lines.push(`${mark}type ${name} = ${declaration.type.typeName.getText()}${note}`);
      } else if (isObject(type)) {
        lines.push(`${mark}type ${name} = {${note}`, ...members(type, '  '), '}');
      } else {
        const text = declaration
          ? written(declaration.type)
          : typeText(type, ts.TypeFormatFlags.InTypeAlias);
        lines.push(`${mark}type ${name} = ${text}${note}`);
      }
    }
    return lines;
  };

  const sections: string[] = [];
  for (const [entry, file] of Object.entries(ENTRIES)) {
    const source = program.getSourceFile(join(root, file));
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`${file} has no exports`);
    const exports = checker
      .getExportsOfModule(moduleSymbol)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const values = exports.filter(
      (symbol) =>
        (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol).flags &
        ts.SymbolFlags.Value,
    );
    const experimental = new Set(EXPERIMENTAL[entry] ?? []);
    const lines = [
      `# ${entry}`,
      '',
      `${String(values.length)} runtime exports, ${String(exports.length - values.length)} types only`,
      '',
    ];
    for (const symbol of exports) {
      lines.push(...describeExport(symbol.name, symbol, experimental.has(symbol.name)));
    }
    sections.push(lines.join('\n'));
  }
  return `${sections.join('\n\n')}\n`;
}

describe('the API report', () => {
  it('covers every entry of the package that has types', () => {
    const { exports } = JSON.parse(read('package.json')) as {
      exports: Record<string, string | { types?: string }>;
    };
    const typed = Object.entries(exports)
      .filter((entry): entry is [string, { types: string }] => {
        const [, target] = entry;
        return typeof target === 'object' && typeof target.types === 'string';
      })
      .map(([path, { types }]) => ({ entry: `ondocs${path.slice(1)}`, types }));
    const reported = new Set(
      typed.filter(({ entry }) => entry in ENTRIES).map(({ types }) => types),
    );
    for (const { entry, types } of typed) {
      // An entry that shares another's types, as ondocs/embed/standalone does ondocs/embed's.
      expect([entry, entry in ENTRIES || reported.has(types)]).toEqual([entry, true]);
    }
  });

  it('matches the committed report', { timeout: 120_000 }, async () => {
    await expect(apiReport()).toMatchFileSnapshot('__snapshots__/api-report.txt');
  });

  it('lists as experimental what the Package API page calls experimental', () => {
    const page = read('examples/nextjs/content/docs/api.md');
    const start = page.indexOf('\n## Experimental');
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf('\n## ', start + 1);
    const section = page.slice(start, end === -1 ? undefined : end);
    const named = new Set([...section.matchAll(/`([\w.]+)`/g)].map((match) => match[1]));
    for (const [entry, names] of Object.entries(EXPERIMENTAL)) {
      for (const name of names) expect([entry, name, named.has(name)]).toEqual([entry, name, true]);
    }
  });
});
