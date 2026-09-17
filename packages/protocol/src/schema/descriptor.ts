/**
 * Message descriptors, and the registry that resolves them.
 *
 * Cursor's `.proto` files are not published, but its own bundles carry the
 * whole schema: `@bufbuild/protobuf` code generation emits every message as a
 * field table, and those tables are recoverable from the installed
 * application. `@mycursor/patcher` does the recovery; this module defines the
 * document it produces and gives the codec a way to look types up.
 *
 * Reading the schema out of the user's own installation, rather than shipping a
 * copy, has three consequences worth stating: no proprietary schema enters this
 * repository, the descriptors always match the installed Cursor version, and a
 * Cursor upgrade is handled by re-extracting instead of by a release here.
 */

/**
 * Protobuf scalar type numbers, as used by `FieldDescriptorProto.Type` and by
 * `@bufbuild/protobuf`'s `ScalarType`.
 */
export const ScalarType = {
  DOUBLE: 1,
  FLOAT: 2,
  INT64: 3,
  UINT64: 4,
  INT32: 5,
  FIXED64: 6,
  FIXED32: 7,
  BOOL: 8,
  STRING: 9,
  BYTES: 12,
  UINT32: 13,
  SFIXED32: 15,
  SFIXED64: 16,
  SINT32: 17,
  SINT64: 18,
} as const;

export type ScalarTypeNumber = (typeof ScalarType)[keyof typeof ScalarType];

export type FieldKind = 'scalar' | 'message' | 'enum' | 'map';

export interface MapValueDescriptor {
  kind: 'scalar' | 'message' | 'enum';
  scalar?: ScalarTypeNumber;
  typeName?: string;
}

export interface FieldDescriptor {
  /** Field number on the wire. */
  no: number;
  /** Name as written in the `.proto` file, in snake_case. */
  name: string;
  /** camelCase name, which is the key used in decoded objects. */
  jsonName: string;
  kind: FieldKind;
  /** Present when `kind` is `scalar`. */
  scalar?: ScalarTypeNumber;
  /** Present when `kind` is `message` or `enum`. */
  typeName?: string;
  repeated?: boolean;
  /** `optional` in proto3, which makes field presence explicit. */
  optional?: boolean;
  /** Name of the oneof this field belongs to. */
  oneof?: string;
  /** Present when `kind` is `map`. */
  map?: { key: ScalarTypeNumber; value: MapValueDescriptor };
}

export interface EnumValueDescriptor {
  no: number;
  name: string;
}

export type MethodKind = 'unary' | 'server-stream' | 'client-stream' | 'bidi';

/** One RPC method, as declared by Cursor's own service definition. */
export interface MethodDescriptor {
  /** Method name as it appears in the request path. */
  name: string;
  kind: MethodKind;
  /** Request message type name. */
  input: string;
  /** Response message type name. */
  output: string;
}

/** The document `@mycursor/patcher` extracts and the server consumes. */
export interface DescriptorDocument {
  $schemaVersion: 1;
  /** Cursor version the schema was recovered from. */
  cursorVersion: string;
  /** File the schema was recovered from, for traceability. */
  source: string;
  extractedAt: string;
  messages: Record<string, FieldDescriptor[]>;
  enums: Record<string, EnumValueDescriptor[]>;
  /**
   * Services, keyed by fully-qualified name, each mapping method name to its
   * signature.
   *
   * Extracted rather than assumed: a method answered with the wrong
   * cardinality — a unary body for a server-streaming call — fails in a way
   * that looks like a network problem from the client's side.
   */
  services: Record<string, Record<string, MethodDescriptor>>;
}

export interface RegistryStats {
  messages: number;
  enums: number;
  services: number;
  methods: number;
  /** Fields whose message or enum type is not in the document. */
  danglingReferences: number;
}

/**
 * Resolves type names to descriptors.
 *
 * Lookup misses are reported rather than thrown: a schema recovered from a
 * future Cursor build may reference a type this document does not contain, and
 * the right response is to fall back to forwarding the request rather than to
 * fail.
 */
export class DescriptorRegistry {
  private readonly messages: Map<string, FieldDescriptor[]>;
  private readonly enums: Map<string, Map<number, string>>;
  private readonly enumsByName: Map<string, Map<string, number>>;
  /** Keyed `service/Method`, matching the RPC request path. */
  private readonly methods = new Map<string, MethodDescriptor & { service: string }>();

  private constructor(
    readonly document: DescriptorDocument,
    messages: Map<string, FieldDescriptor[]>,
    enums: Map<string, Map<number, string>>,
    enumsByName: Map<string, Map<string, number>>,
  ) {
    this.messages = messages;
    this.enums = enums;
    this.enumsByName = enumsByName;
    for (const [service, methods] of Object.entries(document.services ?? {})) {
      for (const method of Object.values(methods)) {
        this.methods.set(`${service}/${method.name}`, { ...method, service });
      }
    }
  }

  static fromDocument(document: DescriptorDocument): DescriptorRegistry {
    const messages = new Map<string, FieldDescriptor[]>();
    for (const [name, fields] of Object.entries(document.messages ?? {})) {
      messages.set(name, fields);
    }

    const enums = new Map<string, Map<number, string>>();
    const enumsByName = new Map<string, Map<string, number>>();
    for (const [name, values] of Object.entries(document.enums ?? {})) {
      const byNumber = new Map<number, string>();
      const byName = new Map<string, number>();
      for (const value of values) {
        byNumber.set(value.no, value.name);
        byName.set(value.name, value.no);
      }
      enums.set(name, byNumber);
      enumsByName.set(name, byName);
    }

    return new DescriptorRegistry(document, messages, enums, enumsByName);
  }

  static empty(): DescriptorRegistry {
    return DescriptorRegistry.fromDocument({
      $schemaVersion: 1,
      cursorVersion: 'unknown',
      source: 'none',
      extractedAt: new Date(0).toISOString(),
      messages: {},
      enums: {},
      services: {},
    });
  }

  /** Looks a method up by the `service/Method` form used in request paths. */
  method(service: string, name: string): (MethodDescriptor & { service: string }) | undefined {
    return this.methods.get(`${service}/${name}`);
  }

  get methodCount(): number {
    return this.methods.size;
  }

  message(typeName: string): FieldDescriptor[] | undefined {
    return this.messages.get(typeName);
  }

  has(typeName: string): boolean {
    return this.messages.has(typeName);
  }

  enumValueName(typeName: string, value: number): string | undefined {
    return this.enums.get(typeName)?.get(value);
  }

  enumValueNumber(typeName: string, name: string): number | undefined {
    return this.enumsByName.get(typeName)?.get(name);
  }

  stats(): RegistryStats {
    let dangling = 0;
    for (const fields of this.messages.values()) {
      for (const field of fields) {
        if (field.kind === 'message' && field.typeName && !this.messages.has(field.typeName)) dangling += 1;
        if (field.kind === 'enum' && field.typeName && !this.enums.has(field.typeName)) dangling += 1;
      }
    }
    return {
      messages: this.messages.size,
      enums: this.enums.size,
      services: Object.keys(this.document.services ?? {}).length,
      methods: this.methods.size,
      danglingReferences: dangling,
    };
  }
}

/** Converts a proto `snake_case` name to the `camelCase` used in objects. */
export function toJsonName(protoName: string): string {
  return protoName.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}
