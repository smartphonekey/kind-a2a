// SPDX-License-Identifier: AGPL-3.0-only

// Command go-parser derives navigation metadata exclusively from supplied source
// strings. It never opens a source path, resolves imports, or executes target code.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io"
	"os"
	"reflect"
	"strconv"
	"strings"
	"text/scanner"
	"unicode"
	"unicode/utf8"
)

const (
	maxRequestBytes     = 64 << 20
	maxFiles            = 2500
	maxSourceBytes      = 2 << 20
	maxTotalSourceBytes = 32 << 20
	maxModuleBytes      = 256 << 10
	maxPathBytes        = 4096
	maxOutputBytes      = 64 << 20
)

type sourceFile struct {
	Path string
	Text string
}

// request contains source strings, not paths to open. readRequest accepts one
// bounded UTF-8 object and rejects duplicate/unknown keys, nulls and duplicate paths.
type request struct {
	Files      []sourceFile
	ModuleText string
}

type tag struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type documentation struct {
	Description string `json:"description"`
	Tags        []tag  `json:"tags"`
}

type symbol struct {
	Name          string        `json:"name"`
	Kind          string        `json:"kind"`
	Exported      bool          `json:"exported"`
	Line          int           `json:"line"`
	EndLine       int           `json:"endLine"`
	Signature     string        `json:"signature"`
	Documentation documentation `json:"documentation"`
}

type testCase struct {
	Name    string `json:"name"`
	Line    int    `json:"line"`
	EndLine int    `json:"endLine"`
}

type fileResult struct {
	Path          string        `json:"path"`
	PackageName   string        `json:"packageName"`
	Documentation documentation `json:"documentation"`
	Symbols       []symbol      `json:"symbols"`
	Imports       []string      `json:"imports"`
	TestCases     []testCase    `json:"testCases"`
	Generated     bool          `json:"generated"`
}

// response preserves file/declaration order and uses empty arrays, never null.
// run writes it only after the complete request parses; failures use stderr and
// a nonzero exit status without partial successful records on stdout.
type response struct {
	ModulePath string       `json:"modulePath"`
	Files      []fileResult `json:"files"`
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "go-parser: %v\n", err)
		os.Exit(1)
	}
}

func run(in io.Reader, out io.Writer) error {
	req, err := readRequest(in)
	if err != nil {
		return err
	}
	modulePath, err := parseModulePath(req.ModuleText)
	if err != nil {
		return err
	}
	result := response{ModulePath: modulePath, Files: []fileResult{}}
	budget := outputBudget(maxOutputBytes)
	if err := budget.reserve(result); err != nil {
		return err
	}
	for _, source := range req.Files {
		file, err := parseSource(source, &budget)
		if err != nil {
			return fmt.Errorf("file %q: %w", source.Path, err)
		}
		result.Files = append(result.Files, file)
	}
	// Nothing reaches stdout until every file and the module declaration succeeds.
	return json.NewEncoder(out).Encode(result)
}

// object uses decoder tokens so duplicate, unknown, missing, and null fields
// cannot acquire encoding/json's otherwise permissive struct-decoding semantics.
func object(dec *json.Decoder, field func(string) error) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if tok != json.Delim('{') {
		return fmt.Errorf("expected JSON object")
	}
	seen := make(map[string]bool)
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		name, ok := tok.(string)
		if !ok {
			return fmt.Errorf("expected object field name")
		}
		if seen[name] {
			return fmt.Errorf("duplicate field %q", name)
		}
		seen[name] = true
		if err := field(name); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	_, err = dec.Token()
	return err
}

func stringValue(dec *json.Decoder) (string, error) {
	tok, err := dec.Token()
	if err != nil {
		return "", err
	}
	value, ok := tok.(string)
	if !ok {
		return "", fmt.Errorf("expected string")
	}
	return value, nil
}

func readRequest(in io.Reader) (request, error) {
	var req request
	data, err := io.ReadAll(io.LimitReader(in, maxRequestBytes+1))
	if err != nil {
		return req, fmt.Errorf("read request: %w", err)
	}
	if len(data) > maxRequestBytes {
		return req, fmt.Errorf("request exceeds %d bytes", maxRequestBytes)
	}
	if !utf8.Valid(data) {
		return req, fmt.Errorf("request must be UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	paths := make(map[string]bool)
	total := 0
	err = object(dec, func(name string) error {
		switch name {
		case "moduleText":
			var err error
			req.ModuleText, err = stringValue(dec)
			if err == nil && len(req.ModuleText) > maxModuleBytes {
				err = fmt.Errorf("exceeds %d bytes", maxModuleBytes)
			}
			return err
		case "files":
			tok, err := dec.Token()
			if err != nil {
				return err
			}
			if tok != json.Delim('[') {
				return fmt.Errorf("expected array")
			}
			req.Files = []sourceFile{}
			for dec.More() {
				if len(req.Files) >= maxFiles {
					return fmt.Errorf("exceeds %d files", maxFiles)
				}
				var source sourceFile
				var hasPath, hasText bool
				err := object(dec, func(field string) error {
					var err error
					switch field {
					case "path":
						hasPath = true
						source.Path, err = stringValue(dec)
					case "text":
						hasText = true
						source.Text, err = stringValue(dec)
					default:
						err = fmt.Errorf("unknown field")
					}
					return err
				})
				if err != nil {
					return fmt.Errorf("entry %d: %w", len(req.Files), err)
				}
				if !hasPath || !hasText {
					return fmt.Errorf("entry %d requires path and text", len(req.Files))
				}
				if source.Path == "" || len(source.Path) > maxPathBytes || strings.ContainsFunc(source.Path, unicode.IsControl) {
					return fmt.Errorf("path must be nonempty, control-free, and at most %d bytes", maxPathBytes)
				}
				if paths[source.Path] {
					return fmt.Errorf("duplicate path %q", source.Path)
				}
				paths[source.Path] = true
				if len(source.Text) > maxSourceBytes {
					return fmt.Errorf("source %q exceeds %d bytes", source.Path, maxSourceBytes)
				}
				total += len(source.Text)
				if total > maxTotalSourceBytes {
					return fmt.Errorf("total source exceeds %d bytes", maxTotalSourceBytes)
				}
				req.Files = append(req.Files, source)
			}
			_, err = dec.Token()
			return err
		default:
			return fmt.Errorf("unknown field")
		}
	})
	if err != nil {
		return req, fmt.Errorf("request: %w", err)
	}
	if req.Files == nil {
		return req, fmt.Errorf("request requires files array")
	}
	if _, err := dec.Token(); err != io.EOF {
		return req, fmt.Errorf("request must contain exactly one JSON object")
	}
	return req, nil
}

// Reserving serialized items before appending bounds output amplification from
// declarations such as huge multi-name specs. The extra byte covers separators.
type outputBudget int

func (b *outputBudget) reserve(value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	*b -= outputBudget(len(encoded) + 1)
	if *b < 0 {
		return fmt.Errorf("output exceeds %d-byte budget", maxOutputBytes)
	}
	return nil
}

func docs(groups ...*ast.CommentGroup) documentation {
	result := documentation{Tags: []tag{}}
	var descriptions []string
	for _, group := range groups {
		if group == nil {
			continue
		}
		clean := &ast.CommentGroup{}
		for _, comment := range group.List {
			copy := *comment
			if strings.HasPrefix(copy.Text, "/*") {
				body := strings.TrimSuffix(strings.TrimPrefix(copy.Text, "/*"), "*/")
				body = strings.TrimPrefix(body, "*")
				lines := strings.Split(body, "\n")
				for i := 1; i < len(lines); i++ {
					line := strings.TrimLeft(lines[i], " \t")
					if strings.HasPrefix(line, "*") {
						lines[i] = strings.TrimPrefix(strings.TrimPrefix(line, "*"), " ")
					}
				}
				copy.Text = "/*" + strings.Join(lines, "\n") + "*/"
			}
			clean.List = append(clean.List, &copy)
		}
		var description []string
		active := -1
		for _, line := range strings.Split(clean.Text(), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "@") {
				parts := strings.Fields(trimmed)
				name := strings.TrimPrefix(parts[0], "@")
				if name != "" && !strings.ContainsFunc(name, func(r rune) bool {
					return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '-' && r != '_'
				}) {
					result.Tags = append(result.Tags, tag{Name: name, Text: strings.TrimSpace(strings.TrimPrefix(trimmed, parts[0]))})
					active = len(result.Tags) - 1
					continue
				}
			}
			if trimmed == "" {
				active = -1
			} else if active >= 0 {
				result.Tags[active].Text = strings.TrimSpace(result.Tags[active].Text + "\n" + trimmed)
				continue
			}
			description = append(description, line)
		}
		if text := strings.TrimSpace(strings.Join(description, "\n")); text != "" {
			descriptions = append(descriptions, text)
		}
	}
	result.Description = strings.Join(descriptions, "\n\n")
	return result
}

type fileParser struct {
	set    *token.FileSet
	file   fileResult
	budget *outputBudget
}

// parseSource uses physical lines and attached Go doc groups. It indexes top-level
// declarations and named members, not local variables, inferred types or resolved
// calls. Generated markers follow ast.IsGenerated; build tags are not evaluated.
func parseSource(source sourceFile, budget *outputBudget) (fileResult, error) {
	set := token.NewFileSet()
	// Object resolution is syntax-local only. Parameter object identities let us
	// exclude shadowed t.Run receivers without resolving a package or importing it.
	parsed, err := parser.ParseFile(set, source.Path, source.Text, parser.ParseComments|parser.AllErrors)
	if err != nil {
		return fileResult{}, fmt.Errorf("parse Go: %w", err)
	}
	p := fileParser{set: set, budget: budget, file: fileResult{
		Path: source.Path, PackageName: parsed.Name.Name, Documentation: docs(parsed.Doc),
		Symbols: []symbol{}, Imports: []string{}, TestCases: []testCase{}, Generated: ast.IsGenerated(parsed),
	}}
	seenImports := make(map[string]bool)
	for _, spec := range parsed.Imports {
		path, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			return fileResult{}, fmt.Errorf("invalid import: %w", err)
		}
		if !seenImports[path] {
			p.file.Imports = append(p.file.Imports, path)
			seenImports[path] = true
		}
	}
	if err := budget.reserve(p.file); err != nil {
		return fileResult{}, err
	}
	for _, decl := range parsed.Decls {
		switch decl := decl.(type) {
		case *ast.FuncDecl:
			name, kind := decl.Name.Name, "function"
			if decl.Recv != nil {
				if len(decl.Recv.List) != 1 {
					return fileResult{}, fmt.Errorf("method %s has ambiguous receiver", name)
				}
				receiver := receiverName(decl.Recv.List[0].Type)
				if receiver == "" {
					return fileResult{}, fmt.Errorf("method %s has unsupported receiver", name)
				}
				name, kind = receiver+"."+name, "method"
			}
			copy := *decl
			copy.Doc, copy.Body = nil, nil
			if err := p.addSymbol(name, kind, decl.Name.Name, decl, &copy, docs(decl.Doc)); err != nil {
				return fileResult{}, err
			}
			if strings.HasSuffix(source.Path, "_test.go") && decl.Recv == nil && testKind(decl.Name.Name) != "" {
				if err := p.addTest(decl.Name.Name, decl); err != nil {
					return fileResult{}, err
				}
				if err := p.subtests(parsed, decl); err != nil {
					return fileResult{}, err
				}
			}
		case *ast.GenDecl:
			for _, spec := range decl.Specs {
				switch spec := spec.(type) {
				case *ast.TypeSpec:
					copy := *spec
					copy.Doc, copy.Comment = nil, nil
					signature := &ast.GenDecl{Tok: token.TYPE, Specs: []ast.Spec{&copy}}
					if err := p.addSymbol(spec.Name.Name, "type", spec.Name.Name, spec, signature, docs(decl.Doc, spec.Doc, spec.Comment)); err != nil {
						return fileResult{}, err
					}
					if err := p.members(spec); err != nil {
						return fileResult{}, err
					}
				case *ast.ValueSpec:
					copy := *spec
					copy.Doc, copy.Comment = nil, nil
					signature := &ast.GenDecl{Tok: decl.Tok, Specs: []ast.Spec{&copy}}
					kind := "variable"
					if decl.Tok == token.CONST {
						kind = "constant"
					}
					for _, name := range spec.Names {
						if name.Name != "_" {
							if err := p.addSymbol(name.Name, kind, name.Name, spec, signature, docs(decl.Doc, spec.Doc, spec.Comment)); err != nil {
								return fileResult{}, err
							}
						}
					}
				}
			}
		}
	}
	return p.file, nil
}

func receiverName(expr ast.Expr) string {
	switch expr := expr.(type) {
	case *ast.Ident:
		return expr.Name
	case *ast.StarExpr:
		return receiverName(expr.X)
	case *ast.ParenExpr:
		return receiverName(expr.X)
	case *ast.IndexExpr:
		return receiverName(expr.X)
	case *ast.IndexListExpr:
		return receiverName(expr.X)
	}
	return ""
}

func (p *fileParser) members(spec *ast.TypeSpec) error {
	var fields *ast.FieldList
	var isInterface bool
	switch typ := spec.Type.(type) {
	case *ast.StructType:
		fields = typ.Fields
	case *ast.InterfaceType:
		fields, isInterface = typ.Methods, true
	default:
		return nil
	}
	for _, field := range fields.List {
		for _, name := range field.Names {
			if name.Name == "_" {
				continue
			}
			kind := "field"
			var signature ast.Node = &ast.ValueSpec{Names: field.Names, Type: field.Type}
			if isInterface {
				kind = "method"
				if typ, ok := field.Type.(*ast.FuncType); ok {
					signature = &ast.FuncDecl{Name: name, Type: typ}
				}
			}
			if err := p.addSymbol(spec.Name.Name+"."+name.Name, kind, name.Name, field, signature, docs(field.Doc, field.Comment)); err != nil {
				return err
			}
		}
	}
	return nil
}

func signature(set *token.FileSet, node ast.Node) (string, error) {
	// go/ast has no replacement visitor. Rewrite only expression slots, replacing
	// literals with their function types: a literal with a nil body cannot be
	// printed because FuncLit.End requires that body. Restore the original tree.
	var restore []func()
	defer func() {
		for _, undo := range restore {
			undo()
		}
	}()
	exprType := reflect.TypeOf((*ast.Expr)(nil)).Elem()
	replace := func(slot reflect.Value) {
		if literal, ok := slot.Interface().(*ast.FuncLit); ok {
			restore = append(restore, func() { slot.Set(reflect.ValueOf(literal)) })
			slot.Set(reflect.ValueOf(literal.Type))
		}
	}
	ast.Inspect(node, func(node ast.Node) bool {
		if node == nil {
			return false
		}
		fields := reflect.ValueOf(node).Elem()
		for i := 0; i < fields.NumField(); i++ {
			field := fields.Field(i)
			if field.Type() == exprType {
				replace(field)
			} else if field.Kind() == reflect.Slice && field.Type().Elem() == exprType {
				for j := 0; j < field.Len(); j++ {
					replace(field.Index(j))
				}
			}
		}
		return true
	})
	var out bytes.Buffer
	config := printer.Config{Mode: printer.UseSpaces | printer.TabIndent, Tabwidth: 8}
	if err := config.Fprint(&out, set, node); err != nil {
		return "", fmt.Errorf("print signature: %w", err)
	}
	return out.String(), nil
}

func (p *fileParser) lines(node ast.Node) (int, int) {
	end := node.End()
	if end > node.Pos() {
		end--
	}
	// Ignore //line directives: consumers index the supplied physical source.
	return p.set.PositionFor(node.Pos(), false).Line, p.set.PositionFor(end, false).Line
}

func (p *fileParser) addSymbol(name, kind, exportName string, node, printable ast.Node, doc documentation) error {
	printed, err := signature(p.set, printable)
	if err != nil {
		return err
	}
	if field, ok := node.(*ast.Field); ok && field.Tag != nil {
		printed += " " + field.Tag.Value
	}
	line, endLine := p.lines(node)
	sym := symbol{Name: name, Kind: kind, Exported: ast.IsExported(exportName), Line: line,
		EndLine: endLine, Signature: printed, Documentation: doc}
	if err := p.budget.reserve(sym); err != nil {
		return err
	}
	p.file.Symbols = append(p.file.Symbols, sym)
	return nil
}

func (p *fileParser) addTest(name string, node ast.Node) error {
	line, endLine := p.lines(node)
	test := testCase{Name: name, Line: line, EndLine: endLine}
	if err := p.budget.reserve(test); err != nil {
		return err
	}
	p.file.TestCases = append(p.file.TestCases, test)
	return nil
}

// testKind identifies naming candidates, not runnable/valid tests or coverage.
// Dynamic names and runtime testing suffixes are not invented; ambiguous literal
// candidates keep their individual source ranges for the caller to disambiguate.
func testKind(name string) string {
	for _, prefix := range []string{"Test", "Benchmark", "Fuzz", "Example"} {
		if strings.HasPrefix(name, prefix) {
			rest := strings.TrimPrefix(name, prefix)
			r, _ := utf8.DecodeRuneInString(rest)
			if rest == "" || !unicode.IsLower(r) {
				return prefix
			}
		}
	}
	return ""
}

type testBinding struct {
	name string
	kind string
}

func (p *fileParser) subtests(file *ast.File, decl *ast.FuncDecl) error {
	if decl.Body == nil {
		return nil
	}
	aliases := make(map[string]bool)
	for _, spec := range file.Imports {
		path, _ := strconv.Unquote(spec.Path.Value)
		if path == "testing" {
			name := "testing"
			if spec.Name != nil {
				name = spec.Name.Name
			}
			aliases[name] = true
		}
	}
	parameter := func(fields *ast.FieldList, kind string) *ast.Object {
		if fields == nil || len(fields.List) == 0 || len(fields.List[0].Names) != 1 {
			return nil
		}
		first := fields.List[0]
		pointer, ok := first.Type.(*ast.StarExpr)
		if !ok {
			return nil
		}
		match := false
		switch typ := pointer.X.(type) {
		case *ast.SelectorExpr:
			name, ok := typ.X.(*ast.Ident)
			match = ok && aliases[name.Name] && name.Name != "_" && typ.Sel.Name == kind
		case *ast.Ident:
			match = aliases["."] && typ.Name == kind
		}
		if !match || first.Names[0].Name == "_" {
			return nil
		}
		return first.Names[0].Obj
	}
	kind := map[string]string{"Test": "T", "Benchmark": "B", "Fuzz": "F"}[testKind(decl.Name.Name)]
	obj := parameter(decl.Type.Params, kind)
	if kind == "" || obj == nil {
		return nil
	}
	bindings := map[*ast.Object]testBinding{obj: {name: decl.Name.Name, kind: kind}}
	var inspect func(ast.Node) error
	inspect = func(root ast.Node) error {
		var err error
		ast.Inspect(root, func(node ast.Node) bool {
			if err != nil {
				return false
			}
			if _, ok := node.(*ast.FuncLit); ok {
				return false
			}
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			receiver, ok := selector.X.(*ast.Ident)
			if !ok {
				return true
			}
			binding, ok := bindings[receiver.Obj]
			if !ok {
				return true
			}
			var callback *ast.FuncLit
			childName, childKind := binding.name, binding.kind
			if selector.Sel.Name == "Run" && binding.kind != "F" && len(call.Args) == 2 {
				literal, ok := call.Args[0].(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					return false
				}
				name, unquoteErr := strconv.Unquote(literal.Value)
				if unquoteErr != nil {
					err = unquoteErr
					return false
				}
				childName += "/" + name
				err = p.addTest(childName, call)
				callback, _ = call.Args[1].(*ast.FuncLit)
			} else if selector.Sel.Name == "Fuzz" && binding.kind == "F" && len(call.Args) == 1 {
				callback, _ = call.Args[0].(*ast.FuncLit)
				childKind = "T"
			} else {
				return true
			}
			if err == nil && callback != nil {
				if child := parameter(callback.Type.Params, childKind); child != nil {
					bindings[child] = testBinding{name: childName, kind: childKind}
					err = inspect(callback.Body)
					delete(bindings, child)
				}
			}
			return false
		})
		return err
	}
	return inspect(decl.Body)
}

type modToken struct {
	text string
	kind rune
	end  int
}

// parseModulePath recognizes a conservative, line-oriented go.mod subset. Other
// directives are not evaluated; balanced blocks and quoted strings are skipped.
func parseModulePath(text string) (string, error) {
	var scan scanner.Scanner
	scan.Init(strings.NewReader(text))
	scan.Filename = "moduleText"
	scan.Mode = scanner.ScanStrings | scanner.ScanRawStrings | scanner.ScanComments
	scan.Whitespace = 1<<' ' | 1<<'\t' | 1<<'\r'
	var scanErr error
	scan.Error = func(s *scanner.Scanner, message string) {
		if scanErr == nil {
			scanErr = fmt.Errorf("%s: %s", s.Position, message)
		}
	}
	var line []modToken
	var modulePath string
	depth := 0
	finishLine := func() error {
		if len(line) == 0 {
			return nil
		}
		if depth == 0 && (line[0].kind != scanner.Ident || strings.ContainsFunc(line[0].text, func(r rune) bool {
			return r < 'a' || r > 'z'
		})) {
			return fmt.Errorf("directive names must be unquoted lowercase words")
		}
		if depth == 0 && line[0].text == "module" {
			if modulePath != "" {
				return fmt.Errorf("duplicate module declaration")
			}
			if len(line) != 2 || (line[1].kind != scanner.Ident && line[1].kind != scanner.String) || line[0].end == line[1].end-len(line[1].text) {
				return fmt.Errorf("module requires exactly one path on the same line")
			}
			path := line[1].text
			if line[1].kind == scanner.String {
				var err error
				path, err = strconv.Unquote(path)
				if err != nil {
					return fmt.Errorf("invalid quoted module path: %w", err)
				}
			}
			if !validModulePath(path) {
				return fmt.Errorf("invalid module path %q", path)
			}
			modulePath = path
		}
		for i, tok := range line {
			switch tok.kind {
			case '(':
				if depth != 0 || i != 1 || len(line) != 2 {
					return fmt.Errorf("expected a top-level 'directive (' line")
				}
				depth = 1
			case ')':
				if depth != 1 || len(line) != 1 {
					return fmt.Errorf("expected a standalone closing parenthesis for an open block")
				}
				depth = 0
			}
		}
		line = nil
		return nil
	}
	for {
		kind := scan.Scan()
		if scanErr != nil {
			return "", scanErr
		}
		raw := scan.TokenText()
		switch kind {
		case scanner.EOF, '\n':
			if err := finishLine(); err != nil {
				return "", fmt.Errorf("moduleText:%d: %w", scan.Position.Line, err)
			}
			if kind == scanner.EOF {
				if depth != 0 {
					return "", fmt.Errorf("moduleText: unclosed directive block")
				}
				return modulePath, nil
			}
		case scanner.Comment:
			if strings.HasPrefix(raw, "/*") {
				return "", fmt.Errorf("moduleText:%d: only // comments are supported", scan.Position.Line)
			}
		case scanner.RawString:
			return "", fmt.Errorf("moduleText:%d: use double-quoted or unquoted paths", scan.Position.Line)
		default:
			if kind != scanner.String && kind != '(' && kind != ')' {
				kind = scanner.Ident
			}
			end := scan.Position.Offset + len(raw)
			if len(line) > 0 && kind == scanner.Ident && line[len(line)-1].kind == kind && line[len(line)-1].end == scan.Position.Offset {
				previous := &line[len(line)-1]
				previous.text = text[previous.end-len(previous.text) : end]
				previous.end = end
			} else {
				line = append(line, modToken{text: raw, kind: kind, end: end})
			}
		}
	}
}

func validModulePath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
		return false
	}
	for _, r := range path {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("/.-_~", r)) {
			return false
		}
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || strings.Trim(part, ".") == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".") || strings.HasPrefix(part, "-") {
			return false
		}
	}
	return true
}
