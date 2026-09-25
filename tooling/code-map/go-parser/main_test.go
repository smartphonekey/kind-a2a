// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func parseFixture(t *testing.T, path, text string) fileResult {
	t.Helper()
	budget := outputBudget(maxOutputBytes)
	file, err := parseSource(sourceFile{Path: path, Text: text}, &budget)
	if err != nil {
		t.Fatal(err)
	}
	return file
}

func findSymbol(t *testing.T, file fileResult, name string) symbol {
	t.Helper()
	for _, sym := range file.Symbols {
		if sym.Name == name {
			return sym
		}
	}
	t.Fatalf("missing symbol %q in %+v", name, file.Symbols)
	return symbol{}
}

func TestDocumentationAndSymbols(t *testing.T) {
	source := `// Copyright Example.

// Package store keeps typed values.
//
// Values retain their keys.
// @see docs/storage.md#keys
//   docs/storage.md#locking
// @since 1.0
package store

import (
    "sync"
    aliased "example.com/external"
    _ "example.com/external"
)

// Options control storage.
type Options struct {
    // Count limits entries.
    // @see docs/storage.md#count
    Count int ` + "`json:\"count\"`" + `
    enabled bool // enabled is private.
    sync.Mutex
}

/*
 * Reader obtains values.
 * @see docs/reader.md
 */
type Reader interface {
    // Read fetches a value.
    Read(key string) (value []byte, err error)
}

// State flags.
const (
    // Ready accepts writes.
    Ready = iota
    stopped // stopped rejects writes.
)

// Names are defaults.
var First, second string = "a", "b"

// Open creates storage.
// @see docs/open.md
func Open(name string) (*Options, error) {
    panic("BODY_MUST_NOT_APPEAR")
}

func private() {}
`
	file := parseFixture(t, "store.go", source)
	if file.PackageName != "store" || file.Generated {
		t.Fatalf("unexpected file metadata: %+v", file)
	}
	if got, want := file.Documentation.Description, "Package store keeps typed values.\n\nValues retain their keys."; got != want {
		t.Fatalf("package description = %q, want %q", got, want)
	}
	wantTags := []tag{{Name: "see", Text: "docs/storage.md#keys\ndocs/storage.md#locking"}, {Name: "since", Text: "1.0"}}
	if !reflect.DeepEqual(file.Documentation.Tags, wantTags) {
		t.Fatalf("package tags = %+v", file.Documentation.Tags)
	}
	if !reflect.DeepEqual(file.Imports, []string{"sync", "example.com/external"}) {
		t.Fatalf("imports = %v", file.Imports)
	}
	open := findSymbol(t, file, "Open")
	if open.Kind != "function" || !open.Exported || open.Signature != "func Open(name string) (*Options, error)" {
		t.Fatalf("Open = %+v", open)
	}
	if open.Documentation.Description != "Open creates storage." || !reflect.DeepEqual(open.Documentation.Tags, []tag{{Name: "see", Text: "docs/open.md"}}) {
		t.Fatalf("Open docs = %+v", open.Documentation)
	}
	if got := findSymbol(t, file, "private"); got.Exported || got.Kind != "function" {
		t.Fatalf("private = %+v", got)
	}
	options := findSymbol(t, file, "Options")
	compactSignature := strings.Join(strings.Fields(options.Signature), " ")
	for _, part := range []string{"type Options struct", "Count int", "enabled bool", "sync.Mutex", "`json:\"count\"`"} {
		if !strings.Contains(compactSignature, part) {
			t.Errorf("Options signature lacks %q: %s", part, options.Signature)
		}
	}
	count := findSymbol(t, file, "Options.Count")
	if count.Kind != "field" || !count.Exported || count.Signature != "Count int `json:\"count\"`" {
		t.Fatalf("Count = %+v", count)
	}
	if count.Documentation.Description != "Count limits entries." || len(count.Documentation.Tags) != 1 {
		t.Fatalf("Count docs = %+v", count.Documentation)
	}
	if got := findSymbol(t, file, "Options.enabled"); got.Exported || got.Documentation.Description != "enabled is private." {
		t.Fatalf("enabled = %+v", got)
	}
	reader := findSymbol(t, file, "Reader")
	if reader.Documentation.Description != "Reader obtains values." || !reflect.DeepEqual(reader.Documentation.Tags, []tag{{Name: "see", Text: "docs/reader.md"}}) {
		t.Fatalf("Reader docs = %+v", reader.Documentation)
	}
	if got := findSymbol(t, file, "Reader.Read"); got.Kind != "method" || got.Signature != "func Read(key string) (value []byte, err error)" {
		t.Fatalf("interface method = %+v", got)
	}
	if got := findSymbol(t, file, "Ready"); got.Kind != "constant" || got.Signature != "const Ready = iota" || got.Documentation.Description != "State flags.\n\nReady accepts writes." {
		t.Fatalf("Ready = %+v", got)
	}
	if got := findSymbol(t, file, "stopped"); got.Exported || got.Signature != "const stopped" || got.Documentation.Description != "State flags.\n\nstopped rejects writes." {
		t.Fatalf("stopped = %+v", got)
	}
	for _, name := range []string{"First", "second"} {
		if got := findSymbol(t, file, name); got.Kind != "variable" || got.Signature != `var First, second string = "a", "b"` {
			t.Fatalf("%s = %+v", name, got)
		}
	}
}

func TestGenericMultilineSignaturesAndReceivers(t *testing.T) {
	source := `package collections

type Pair[A, B any] struct { First A; Second B }
type Alias[T any] = []T
type Number interface { ~int | ~int64 }

// Map preserves result ordering.
func Map[
    T Number,
    U any,
](
    input []T,
    transform func(T) U,
) (
    output []U,
    err error,
) {
    panic("DO_NOT_PRINT_MAP_BODY")
}

// Swap reverses the elements.
func (pair *Pair[A, B]) Swap() Pair[B, A] {
    panic("DO_NOT_PRINT_SWAP_BODY")
}

func (Pair[A, B]) Value() A { panic("DO_NOT_PRINT_VALUE_BODY") }
func (pair Pair[A, B]) private() {}
type Box[T any] struct { Value T }
func (box *Box[T]) Get() T { return box.Value }
`
	file := parseFixture(t, "collections.go", source)
	swap := findSymbol(t, file, "Pair.Swap")
	if swap.Kind != "method" || !swap.Exported || swap.Signature != "func (pair *Pair[A, B]) Swap() Pair[B, A]" || swap.Documentation.Description != "Swap reverses the elements." {
		t.Fatalf("Swap = %+v", swap)
	}
	if got := findSymbol(t, file, "Pair.Value"); got.Signature != "func (Pair[A, B]) Value() A" {
		t.Fatalf("Value = %+v", got)
	}
	if findSymbol(t, file, "Pair.private").Exported {
		t.Fatal("private method marked exported")
	}
	if got := findSymbol(t, file, "Box.Get"); got.Signature != "func (box *Box[T]) Get() T" {
		t.Fatalf("Get = %+v", got)
	}
	if got := findSymbol(t, file, "Alias"); got.Signature != "type Alias[T any] = []T" {
		t.Fatalf("Alias = %+v", got)
	}
	if got := findSymbol(t, file, "Number"); !strings.Contains(got.Signature, "~int | ~int64") {
		t.Fatalf("Number = %+v", got)
	}
	mapFunc := findSymbol(t, file, "Map")
	for _, part := range []string{"func Map[", "T Number", "U any", "input []T", "transform func(T) U", "output []U", "err error"} {
		if !strings.Contains(mapFunc.Signature, part) {
			t.Errorf("Map signature lacks %q: %s", part, mapFunc.Signature)
		}
	}
	if mapFunc.Line != 8 || mapFunc.EndLine != 19 {
		t.Fatalf("Map range = %d-%d", mapFunc.Line, mapFunc.EndLine)
	}
	for _, sym := range file.Symbols {
		if strings.Contains(sym.Signature, "DO_NOT_PRINT") {
			t.Fatalf("body leaked into %s signature", sym.Name)
		}
	}
}

func TestExportedFlagsAreLexicalNotParentReachability(t *testing.T) {
	file := parseFixture(t, "visibility.go", `package p
type hidden struct { Public int; private int }
type hiddenContract interface { Public(); private() }
type PublicAlias = hidden
func (*hidden) PublicMethod() {}
func (*hidden) privateMethod() {}
`)
	want := map[string]bool{
		"hidden": false, "hidden.Public": true, "hidden.private": false,
		"hiddenContract": false, "hiddenContract.Public": true, "hiddenContract.private": false,
		"PublicAlias": true, "hidden.PublicMethod": true, "hidden.privateMethod": false,
	}
	for name, exported := range want {
		if got := findSymbol(t, file, name); got.Exported != exported {
			t.Errorf("%s exported = %v, want lexical export %v", name, got.Exported, exported)
		}
	}
}

func TestBlockCommentTags(t *testing.T) {
	file := parseFixture(t, "block.go", `/** Package block documents storage.
 * @see docs/package.md */
package block
/** @see docs/single.md */
func Single() {}
/* Multi describes behavior.
 * @see docs/multi.md
 */
func Multi() {}
`)
	if file.Documentation.Description != "Package block documents storage." || !reflect.DeepEqual(file.Documentation.Tags, []tag{{Name: "see", Text: "docs/package.md"}}) {
		t.Fatalf("block package docs = %+v", file.Documentation)
	}
	single := findSymbol(t, file, "Single").Documentation
	if single.Description != "" || !reflect.DeepEqual(single.Tags, []tag{{Name: "see", Text: "docs/single.md"}}) {
		t.Fatalf("single block docs = %+v", single)
	}
	multi := findSymbol(t, file, "Multi").Documentation
	if multi.Description != "Multi describes behavior." || !reflect.DeepEqual(multi.Tags, []tag{{Name: "see", Text: "docs/multi.md"}}) {
		t.Fatalf("multi block docs = %+v", multi)
	}
}

func TestSignaturesAreFullAndOmitLiteralBodies(t *testing.T) {
	source := `package p
var Handler = func(value string) error { panic("LITERAL_BODY") }
var Computed = func() int { panic("CALLED_BODY") }()
var Table = map[string]func() { "x": func() { panic("NESTED_BODY") } }
var Left, Right = func() int { panic("LEFT_BODY") }, func() { panic("RIGHT_BODY") }
var _, Public = 1, 2
type Large struct {
` + strings.Repeat("// A field comment.\n", 100) + `Field int
}
`
	file := parseFixture(t, "literals.go", source)
	if got := findSymbol(t, file, "Handler"); got.Signature != "var Handler = func(value string) error" {
		t.Fatalf("Handler = %+v", got)
	}
	if len(findSymbol(t, file, "Large").Signature) < 800 {
		t.Fatal("large type signature was truncated")
	}
	if left, right := findSymbol(t, file, "Left"), findSymbol(t, file, "Right"); left.Signature != right.Signature || left.EndLine != left.Line || right.EndLine != right.Line {
		t.Fatalf("multi-name literal AST was not restored: %+v, %+v", left, right)
	}
	for _, sym := range file.Symbols {
		if sym.Name == "_" || strings.Contains(sym.Signature, "_BODY") {
			t.Fatalf("unexpected symbol: %+v", sym)
		}
	}
}

func TestPhysicalLinesIgnoreLineDirectives(t *testing.T) {
	source := "package p\r\n//line pretend.go:900\r\n// Work documents behavior.\r\nfunc Work() {\r\n}\r\n"
	file := parseFixture(t, "physical.go", source)
	work := findSymbol(t, file, "Work")
	if work.Line != 4 || work.EndLine != 5 {
		t.Fatalf("physical range = %d-%d", work.Line, work.EndLine)
	}
}

func TestGeneratedMarkers(t *testing.T) {
	cases := []struct {
		name, text string
		generated  bool
	}{
		{"standard", "// Code generated by a tool. DO NOT EDIT.\npackage p", true},
		{"afterLicense", "// License.\n\n// Code generated test. DO NOT EDIT.\n\n// Package p is generated.\npackage p", true},
		{"afterPackage", "package p\n// Code generated by a tool. DO NOT EDIT.\n", false},
		{"wrongCase", "// code generated by a tool. DO NOT EDIT.\npackage p", false},
		{"unfinished", "// Code generated by a tool.\npackage p", false},
		{"block", "/* Code generated by a tool. DO NOT EDIT. */\npackage p", false},
		{"string", "package p\nconst X = `// Code generated by a tool. DO NOT EDIT.`", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseFixture(t, "generated.go", tc.text).Generated; got != tc.generated {
				t.Fatalf("generated = %v, want %v", got, tc.generated)
			}
		})
	}
}

func TestTestCandidatesAndLiteralSubtests(t *testing.T) {
	source := `package store
import tt "testing"

func TestStore(t *tt.T) {
    t.Run("first", func(t *tt.T) {
        t.Run("nested", func(t *tt.T) {})
    })
    t.Run("same", func(t *tt.T) {})
    t.Run("same", func(t *tt.T) {})
    t.Run("with space", runHelper)
    t.Run("", runHelper)
    t.Run(` + "`raw/name`" + `, runHelper)
    t.Run(dynamic, func(t *tt.T) { t.Run("unknown parent", runHelper) })
    t.Run("computed" + suffix, runHelper)
    { t := fake{}; t.Run("shadowed", runHelper) }
    closure := func() { t.Run("not invoked", runHelper) }
    alias := t
    alias.Run("alias not tracked", runHelper)
    unrelated.Run("not a test", runHelper)
}

func BenchmarkStore(b *tt.B) { b.Run("size", func(b *tt.B) {}) }
func FuzzStore(f *tt.F) {
    f.Fuzz(func(t *tt.T, input string) { t.Run("roundtrip", runHelper) })
}
func Example() {}
func ExampleStore_lookup() {}
func Test() {}
func Testlowercase(t *tt.T) {}
func Benchmarklowercase(b *tt.B) {}
func Examplelowercase() {}
func (s store) TestMethod(t *tt.T) {}
func helper(t *tt.T) { t.Run("helper not tracked", runHelper) }
func TestFake(t *fake) { t.Run("not testing.T", runHelper) }
`
	file := parseFixture(t, "store_test.go", source)
	var names []string
	for _, tc := range file.TestCases {
		names = append(names, tc.Name)
		if tc.Line <= 0 || tc.EndLine < tc.Line {
			t.Fatalf("bad range: %+v", tc)
		}
	}
	want := []string{
		"TestStore", "TestStore/first", "TestStore/first/nested", "TestStore/same", "TestStore/same",
		"TestStore/with space", "TestStore/", "TestStore/raw/name", "BenchmarkStore", "BenchmarkStore/size",
		"FuzzStore", "FuzzStore/roundtrip", "Example", "ExampleStore_lookup", "Test", "TestFake",
	}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("test names = %q, want %q", names, want)
	}
	if file.TestCases[1].Line != 5 || file.TestCases[1].EndLine != 7 {
		t.Fatalf("subtest range = %+v", file.TestCases[1])
	}
	if file.TestCases[3].Line == file.TestCases[4].Line {
		t.Fatal("duplicate names lost their distinct source locations")
	}
	if cases := parseFixture(t, "store.go", source).TestCases; len(cases) != 0 {
		t.Fatalf("non-test file has test cases: %+v", cases)
	}
}

func TestDotTestingImportAndOuterReceiver(t *testing.T) {
	source := `package p_test
import . "testing"
func TestOuter(t *T) {
    t.Run("child", func(inner *T) {
        inner.Run("grandchild", helper)
        t.Run("outer receiver", helper)
    })
}
`
	file := parseFixture(t, "p_test.go", source)
	want := []string{"TestOuter", "TestOuter/child", "TestOuter/child/grandchild", "TestOuter/outer receiver"}
	var got []string
	for _, tc := range file.TestCases {
		got = append(got, tc.Name)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cases = %v, want %v", got, want)
	}
}

func TestParseModulePath(t *testing.T) {
	cases := []struct{ text, want string }{
		{"", ""},
		{"// module fake.example/ignored\ngo 1.24\n", ""},
		{"module example.com/a\n", "example.com/a"},
		{"\ufeffmodule example.com/a", "example.com/a"},
		{"module local\r\ngo 1.24\r\n", "local"},
		{"module \"example.com/a\" // trailing\n", "example.com/a"},
		{"module \"example.com/\\u0061\"", "example.com/a"},
		{"module example.com/a// trailing", "example.com/a"},
		{"module example.com//broken/path", "example.com"},
		{"require (\n module v1.0.0\n \"example.com/other\" v1.0.0\n)\nmodule example.com/main/v2\nreplace example.com/other => ../other\n", "example.com/main/v2"},
		{"module gopkg.in/yaml.v3\nretract [v1.0.0, v1.1.0]\n", "gopkg.in/yaml.v3"},
	}
	for _, tc := range cases {
		t.Run(tc.text, func(t *testing.T) {
			got, err := parseModulePath(tc.text)
			if err != nil || got != tc.want {
				t.Fatalf("parseModulePath(%q) = %q, %v; want %q", tc.text, got, err, tc.want)
			}
		})
	}
}

func TestMalformedOrAmbiguousModule(t *testing.T) {
	cases := []string{
		"module", "module\nexample.com/a", "module ()", "module (\nexample.com/a\n)",
		"module a b", "module a\nmodule b", "module a\nmodule a", "module \"\"", "module \"a b\"",
		"module \"unterminated", "module \"example.com/a\n\"", "module 'example.com/a'", "module `example.com/a`",
		"module\"example.com/a\"", "module /absolute", "module a/", "module a/../b",
		"module .hidden/path", "module a/@v1", "module a;module b", "module a\\b", "module a\n/* module b */",
		"require (\nexample.com/a v1.0.0", "require (\n(\n)\n)", ")\nmodule a",
		"\"module\" a", "module a\n\"module\" b", "module=a", "(module a)",
		"require (\nexample.com/a v1.0.0\n) module a", "require (example.com/a v1.0.0)",
	}
	for _, source := range cases {
		t.Run(source, func(t *testing.T) {
			if got, err := parseModulePath(source); err == nil {
				t.Fatalf("accepted malformed module %q as %q", source, got)
			}
		})
	}
}

func requestJSON(t *testing.T, files []sourceFile, moduleText string) string {
	t.Helper()
	wireFiles := make([]map[string]string, 0, len(files))
	for _, file := range files {
		wireFiles = append(wireFiles, map[string]string{"path": file.Path, "text": file.Text})
	}
	encoded, err := json.Marshal(map[string]any{"files": wireFiles, "moduleText": moduleText})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestRequestResponseContractAndSamePackageTests(t *testing.T) {
	files := []sourceFile{
		{Path: "store.go", Text: "// Package store keeps values.\npackage store\nfunc Open() {}\n"},
		{Path: "store_test.go", Text: "package store\nimport \"testing\"\nfunc TestOpen(t *testing.T) { Open() }\n"},
		{Path: "external_test.go", Text: "package store_test\nfunc ExampleOpen() {}"},
	}
	input := requestJSON(t, files, "module example.com/store\n")
	var out bytes.Buffer
	if err := run(strings.NewReader(input), &out); err != nil {
		t.Fatal(err)
	}
	var got response
	dec := json.NewDecoder(&out)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.ModulePath != "example.com/store" || len(got.Files) != 3 {
		t.Fatalf("response = %+v", got)
	}
	for i, file := range got.Files {
		if file.Path != files[i].Path || file.Symbols == nil || file.Imports == nil || file.TestCases == nil || file.Documentation.Tags == nil {
			t.Fatalf("file contract = %+v", file)
		}
		for _, sym := range file.Symbols {
			if sym.Documentation.Tags == nil {
				t.Fatal("null symbol tags")
			}
		}
	}
	if got.Files[1].PackageName != "store" || len(got.Files[1].TestCases) != 1 || got.Files[1].TestCases[0].Name != "TestOpen" {
		t.Fatalf("same-package tests = %+v", got.Files[1])
	}
	if got.Files[2].PackageName != "store_test" {
		t.Fatalf("external package = %+v", got.Files[2])
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		t.Fatalf("output contains more than one object: %v", err)
	}
	out.Reset()
	if err := run(strings.NewReader(`{"files":[]}`), &out); err != nil || out.String() != "{\"modulePath\":\"\",\"files\":[]}\n" {
		t.Fatalf("empty response = %q, %v", out.String(), err)
	}
}

func TestRejectsInvalidRequests(t *testing.T) {
	cases := []string{
		"", "{", "[]", "null", `{}`, `{"files":null}`, `{"files":{}}`, `{"files":[null]}`,
		`{"files":[],"extra":true}`, `{"files":[],"Files":[]}`, `{"files":[],"files":[]}`,
		`{"files":[],"moduleText":null}`, `{"files":[],"moduleText":5}`, `{"files":[],"moduleText":"","moduleText":""}`,
		`{"files":[]} {"files":[]}`, `{"files":[]} trailing`, `{"files":[]} null`,
		`{"files":[{"path":"x.go"}]}`, `{"files":[{"text":"package p"}]}`,
		`{"files":[{"path":"x.go","text":null}]}`, `{"files":[{"path":null,"text":"package p"}]}`,
		`{"files":[{"path":"","text":"package p"}]}`, `{"files":[{"path":"x\n.go","text":"package p"}]}`,
		`{"files":[{"path":"x\u0000.go","text":"package p"}]}`, `{"files":[{"path":"x.go","path":"y.go","text":"package p"}]}`,
		`{"files":[{"path":"x.go","text":"package p","execute":true}]}`,
		`{"files":[{"path":"x.go","text":"package p"},{"path":"x.go","text":"package p"}]}`,
		"{\"files\":[],\"moduleText\":\"\xff\"}",
	}
	for _, input := range cases {
		t.Run(input, func(t *testing.T) {
			var out bytes.Buffer
			if err := run(strings.NewReader(input), &out); err == nil || out.Len() != 0 {
				t.Fatalf("invalid request returned error=%v, stdout=%q", err, out.String())
			}
		})
	}
}

func TestMalformedGoFailsWholeRequest(t *testing.T) {
	for _, source := range []string{"", "package", "package p\nfunc Broken( {", "package p\nvar x = \"unterminated", "package p\nfunc F() { if true { }", "package p\nimport \"bad\\q\""} {
		t.Run(source, func(t *testing.T) {
			input := requestJSON(t, []sourceFile{{Path: "good.go", Text: "package p"}, {Path: "broken.go", Text: source}}, "")
			var out bytes.Buffer
			err := run(strings.NewReader(input), &out)
			if err == nil || !strings.Contains(err.Error(), "broken.go") || out.Len() != 0 {
				t.Fatalf("parse failure = %v; stdout = %q", err, out.String())
			}
		})
	}
	var out bytes.Buffer
	if err := run(strings.NewReader(requestJSON(t, nil, "module a\nmodule b")), &out); err == nil || out.Len() != 0 {
		t.Fatalf("ambiguous module returned %v, %q", err, out.String())
	}
}

func TestNoSourceReadsResolutionOrExecution(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "must-not-exist")
	source := fmt.Sprintf(`//go:generate sh -c "exit 99"
package supplied
import (
    "os"
    _ "dependency.invalid/not-installed"
)
func init() { os.WriteFile(%q, []byte("executed"), 0600); panic("never execute") }
var SideEffect = func() int { panic("never evaluate") }()
`, marker)
	input := requestJSON(t, []sourceFile{
		{Path: "main.go", Text: source},
		{Path: "/nonexistent/source/never-open.go", Text: "package virtual"},
	}, "module example.com/supplied\nreplace dependency.invalid/not-installed => /nonexistent/target\n")
	var out bytes.Buffer
	if err := run(strings.NewReader(input), &out); err != nil {
		t.Fatal(err)
	}
	var result response
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Files[0].PackageName != "supplied" || result.Files[1].PackageName != "virtual" {
		t.Fatalf("paths were read instead of source strings: %+v", result)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("target code executed or unexpected stat error: %v", err)
	}
}

type repeatingReader struct{ remaining int64 }

func (r *repeatingReader) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	for i := range p {
		p[i] = ' '
	}
	r.remaining -= int64(len(p))
	return len(p), nil
}

func TestInputBounds(t *testing.T) {
	t.Run("wireBytes", func(t *testing.T) {
		reader := &repeatingReader{remaining: maxRequestBytes + 100}
		_, err := readRequest(reader)
		if err == nil || !strings.Contains(err.Error(), "request exceeds") || reader.remaining != 99 {
			t.Fatalf("wire bound: error=%v, remaining=%d", err, reader.remaining)
		}
	})
	t.Run("fileCount", func(t *testing.T) {
		files := make([]sourceFile, maxFiles+1)
		for i := range files {
			files[i] = sourceFile{Path: fmt.Sprintf("%d.go", i), Text: "package p"}
		}
		_, err := readRequest(strings.NewReader(requestJSON(t, files, "")))
		if err == nil || !strings.Contains(err.Error(), "2500 files") {
			t.Fatalf("file bound: %v", err)
		}
	})
	t.Run("sourceBytes", func(t *testing.T) {
		_, err := readRequest(strings.NewReader(requestJSON(t, []sourceFile{{Path: "large.go", Text: strings.Repeat(" ", maxSourceBytes+1)}}, "")))
		if err == nil || !strings.Contains(err.Error(), "source \"large.go\" exceeds") {
			t.Fatalf("source bound: %v", err)
		}
	})
	t.Run("totalSourceBytes", func(t *testing.T) {
		files := make([]sourceFile, maxTotalSourceBytes/maxSourceBytes+1)
		for i := range files {
			files[i] = sourceFile{Path: fmt.Sprintf("%d.go", i), Text: strings.Repeat(" ", maxSourceBytes)}
		}
		_, err := readRequest(strings.NewReader(requestJSON(t, files, "")))
		if err == nil || !strings.Contains(err.Error(), "total source exceeds") {
			t.Fatalf("total source bound: %v", err)
		}
	})
	t.Run("pathBytes", func(t *testing.T) {
		_, err := readRequest(strings.NewReader(requestJSON(t, []sourceFile{{Path: strings.Repeat("x", maxPathBytes+1), Text: "package p"}}, "")))
		if err == nil || !strings.Contains(err.Error(), "path must") {
			t.Fatalf("path bound: %v", err)
		}
	})
	t.Run("moduleBytes", func(t *testing.T) {
		_, err := readRequest(strings.NewReader(requestJSON(t, nil, strings.Repeat(" ", maxModuleBytes+1))))
		if err == nil || !strings.Contains(err.Error(), "moduleText: exceeds") {
			t.Fatalf("module bound: %v", err)
		}
	})
	t.Run("exactLimits", func(t *testing.T) {
		files := []sourceFile{{Path: strings.Repeat("x", maxPathBytes), Text: strings.Repeat(" ", maxSourceBytes)}}
		if _, err := readRequest(strings.NewReader(requestJSON(t, files, strings.Repeat(" ", maxModuleBytes)))); err != nil {
			t.Fatalf("valid boundary rejected: %v", err)
		}
	})
}

func TestOutputBudget(t *testing.T) {
	budget := outputBudget(1000)
	_, err := parseSource(sourceFile{Path: "large.go", Text: "package p\nvar A, B, C, D, E = \"" + strings.Repeat("x", 500) + "\", 1, 2, 3, 4"}, &budget)
	if err == nil || !strings.Contains(err.Error(), "output exceeds") {
		t.Fatalf("output budget error = %v", err)
	}
}

type failingIO struct{}

func (failingIO) Read([]byte) (int, error)  { return 0, errors.New("read failed") }
func (failingIO) Write([]byte) (int, error) { return 0, errors.New("write failed") }

func TestIOErrors(t *testing.T) {
	if err := run(failingIO{}, io.Discard); err == nil || !strings.Contains(err.Error(), "read failed") {
		t.Fatalf("read failure = %v", err)
	}
	if err := run(strings.NewReader(`{"files":[]}`), failingIO{}); err == nil || !strings.Contains(err.Error(), "write failed") {
		t.Fatalf("write failure = %v", err)
	}
}

func FuzzSourceParsing(f *testing.F) {
	for _, source := range []string{
		"package p", "package p\nfunc Broken( {", "// Package p.\n// @see docs/p.md\npackage p",
		"package p\nvar F = func() int { panic(1) }()",
		"package p\ntype Box[T any] struct { Value T }; func (b *Box[T]) Get() T { return b.Value }",
		"package p\nimport \"testing\"\nfunc TestP(t *testing.T) { t.Run(\"x\", func(t *testing.T) {}) }",
	} {
		f.Add(source)
	}
	f.Fuzz(func(t *testing.T, source string) {
		if len(source) > 16<<10 {
			t.Skip()
		}
		budget := outputBudget(1 << 20)
		file, err := parseSource(sourceFile{Path: "fuzz_test.go", Text: source}, &budget)
		if err != nil {
			return
		}
		for _, sym := range file.Symbols {
			if sym.Line < 1 || sym.EndLine < sym.Line || sym.Name == "" || sym.Signature == "" || sym.Documentation.Tags == nil {
				t.Fatalf("invalid symbol: %+v", sym)
			}
		}
	})
}

func FuzzModuleParsing(f *testing.F) {
	for _, source := range []string{
		"", "module example.com/a", "module \"example.com/a\"\nrequire (\nother v1.0.0\n)",
		"module a\nmodule b", "module `a`", "// module ignored\ngo 1.24",
	} {
		f.Add(source)
	}
	f.Fuzz(func(t *testing.T, source string) {
		if len(source) > 16<<10 {
			t.Skip()
		}
		path, err := parseModulePath(source)
		if err == nil && path != "" && !validModulePath(path) {
			t.Fatalf("invalid module path returned: %q", path)
		}
	})
}
