package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
)

//go:embed web
var webFS embed.FS

const prefix = "/app/gomoku"

// record 是单个用户在服务端的战绩，用于全服排行。
type record struct {
	Wins   int `json:"wins"`
	Losses int `json:"losses"`
	Draws  int `json:"draws"`
}

type statsStore struct {
	mu   sync.Mutex
	path string
	Data map[string]*record
}

func newStatsStore(path string) *statsStore {
	s := &statsStore{path: path, Data: map[string]*record{}}
	if b, err := os.ReadFile(path); err == nil {
		var loaded struct {
			Data map[string]*record `json:"data"`
		}
		if json.Unmarshal(b, &loaded) == nil && loaded.Data != nil {
			s.Data = loaded.Data
		}
	}
	return s
}

// flush 先写临时文件再重命名，避免进程被杀时留下半个 JSON。
func (s *statsStore) flush() error {
	payload, err := json.MarshalIndent(struct {
		Data map[string]*record `json:"data"`
	}{Data: s.Data}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

type entry struct {
	User   string `json:"user"`
	Wins   int    `json:"wins"`
	Losses int    `json:"losses"`
}

type app struct {
	store *statsStore
}

func (a *app) user(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("X-Trim-Userid")); v != "" {
		return v
	}
	return "local"
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *app) handleMe(w http.ResponseWriter, r *http.Request) {
	uid := a.user(r)
	a.store.mu.Lock()
	rec, ok := a.store.Data[uid]
	if !ok {
		rec = &record{}
	}
	snapshot := *rec
	a.store.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"user":   uid,
		"wins":   snapshot.Wins,
		"losses": snapshot.Losses,
		"draws":  snapshot.Draws,
	})
}

func (a *app) handleResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var body struct {
		Result string `json:"result"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}

	uid := a.user(r)
	a.store.mu.Lock()
	rec, ok := a.store.Data[uid]
	if !ok {
		rec = &record{}
		a.store.Data[uid] = rec
	}
	switch body.Result {
	case "win":
		rec.Wins++
	case "loss":
		rec.Losses++
	case "draw":
		rec.Draws++
	default:
		a.store.mu.Unlock()
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown result"})
		return
	}
	snapshot := *rec
	err := a.store.flush()
	a.store.mu.Unlock()
	if err != nil {
		log.Printf("flush stats: %v", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":   uid,
		"wins":   snapshot.Wins,
		"losses": snapshot.Losses,
		"draws":  snapshot.Draws,
	})
}

func (a *app) handleLeaderboard(w http.ResponseWriter, r *http.Request) {
	a.store.mu.Lock()
	list := make([]entry, 0, len(a.store.Data))
	for uid, rec := range a.store.Data {
		list = append(list, entry{User: uid, Wins: rec.Wins, Losses: rec.Losses})
	}
	a.store.mu.Unlock()

	sort.Slice(list, func(i, j int) bool {
		if list[i].Wins != list[j].Wins {
			return list[i].Wins > list[j].Wins
		}
		if list[i].Losses != list[j].Losses {
			return list[i].Losses < list[j].Losses
		}
		return list[i].User < list[j].User
	})
	if len(list) > 10 {
		list = list[:10]
	}
	writeJSON(w, http.StatusOK, map[string]any{"top": list})
}

func (a *app) routes() http.Handler {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("embed web: %v", err)
	}
	files := http.FileServer(http.FS(sub))

	mux := http.NewServeMux()
	mux.HandleFunc(prefix+"/api/me", a.handleMe)
	mux.HandleFunc(prefix+"/api/result", a.handleResult)
	mux.HandleFunc(prefix+"/api/leaderboard", a.handleLeaderboard)

	// 入口无尾斜杠，前端一律用绝对路径请求，避免相对路径解析到错误位置。
	mux.HandleFunc(prefix, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != prefix {
			http.NotFound(w, r)
			return
		}
		body, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			http.Error(w, "index.html missing", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(body)
	})
	mux.Handle(prefix+"/", http.StripPrefix(prefix+"/", files))

	return mux
}

func main() {
	log.SetFlags(log.LstdFlags)

	dest := os.Getenv("TRIM_APPDEST")
	dev := dest == ""

	var varDir string
	if dev {
		// 本地调试：没有 fnOS 环境变量时监听 TCP，方便浏览器直接打开。
		varDir = "devdata"
	} else {
		varDir = os.Getenv("TRIM_PKGVAR")
		if varDir == "" {
			varDir = dest
		}
	}

	a := &app{store: newStatsStore(filepath.Join(varDir, "stats.json"))}
	handler := a.routes()
	srv := &http.Server{Handler: handler}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sig
		_ = srv.Close()
	}()

	if dev {
		addr := "127.0.0.1:8787"
		log.Printf("dev mode: http://%s%s (stats in %s)", addr, prefix, varDir)
		if err := http.ListenAndServe(addr, handler); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
		return
	}

	sock := filepath.Join(dest, "app.sock")
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		log.Fatalf("listen %s: %v", sock, err)
	}
	if err := os.Chmod(sock, 0o666); err != nil {
		log.Printf("chmod socket: %v", err)
	}
	log.Printf("listening on unix %s with prefix %s", sock, prefix)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
	_ = os.Remove(sock)
}
