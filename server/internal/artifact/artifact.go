// Package artifact stores artifact bytes.
//
// A file is stored once, under its SHA-256, however many modules upload it:
// the database says which module has which file under which name, the store
// only knows content. Writing goes to a temporary file first and is renamed
// into place when the hashes are known, so a half-uploaded file never looks
// like a real one and a crash mid-upload leaves nothing behind that matters.
//
// Store is an interface so that an object store (S3 and the like) can take
// the filesystem's place later without touching the API.
package artifact

import (
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Sums are what the API reports about an artifact.
type Sums struct {
	SHA1   string
	MD5    string
	SHA256 string
	Size   int64
}

// Store keeps artifact bytes by SHA-256.
type Store interface {
	// Put reads r to the end, stores it and returns its hashes.
	Put(r io.Reader) (Sums, error)
	// Open opens stored bytes; the caller closes. ReadSeeker, because a
	// device resumes and a delta downloads ranges.
	Open(sha256 string) (File, error)
	// Delete removes bytes no artifact refers to any more.
	Delete(sha256 string) error
}

type File interface {
	io.ReadSeekCloser
	Stat() (os.FileInfo, error)
}

// FS stores artifacts in a directory, two levels of fan-out deep so that no
// directory holds more than a few thousand files.
type FS struct{ dir string }

func NewFS(dir string) (*FS, error) {
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o750); err != nil {
		return nil, fmt.Errorf("artifact directory: %w", err)
	}
	return &FS{dir: dir}, nil
}

func (f *FS) path(sha string) string {
	return filepath.Join(f.dir, sha[0:2], sha[2:4], sha)
}

func (f *FS) Put(r io.Reader) (Sums, error) {
	tmp, err := os.CreateTemp(filepath.Join(f.dir, "tmp"), "upload-*")
	if err != nil {
		return Sums{}, err
	}
	defer os.Remove(tmp.Name()) // a no-op once it has been renamed
	h1, h5, h256 := sha1.New(), md5.New(), sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h1, h5, h256), r)
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return Sums{}, err
	}
	s := Sums{
		SHA1:   hex.EncodeToString(h1.Sum(nil)),
		MD5:    hex.EncodeToString(h5.Sum(nil)),
		SHA256: hex.EncodeToString(h256.Sum(nil)),
		Size:   n,
	}
	dst := f.path(s.SHA256)
	if _, err := os.Stat(dst); err == nil {
		return s, nil // the same bytes are already there
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return Sums{}, err
	}
	return s, os.Rename(tmp.Name(), dst)
}

func (f *FS) Open(sha string) (File, error) {
	if len(sha) != 64 {
		return nil, errors.New("not a sha256: " + sha)
	}
	return os.Open(f.path(sha))
}

func (f *FS) Delete(sha string) error {
	if len(sha) != 64 {
		return nil
	}
	err := os.Remove(f.path(sha))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
