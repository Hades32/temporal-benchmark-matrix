package main

import (
	"bytes"
	"context"
	"io/ioutil"
	"log"
	"net/http"
	"os"

	"github.com/K-Phoen/grabana"
	"github.com/K-Phoen/grabana/decoder"
)

func main() {
	content, err := ioutil.ReadFile("./dashboards/stack.yaml")
	if err != nil {
		log.Fatalf("could not read file: %v\n", err)
	}

	dashboard, err := decoder.UnmarshalYAML(bytes.NewBuffer(content))
	if err != nil {
		log.Fatalf("could not parse file: %v\n", err)
	}

	ctx := context.Background()
	client := grabana.NewClient(&http.Client{}, os.Getenv("GRAFANA_HOST"), grabana.WithAPIToken(os.Getenv("GRAFANA_API_TOKEN")))

	folder, err := client.FindOrCreateFolder(ctx, "Benchmarks")
	if err != nil {
		log.Fatalf("could not find or create folder: %v\n", err)
	}

	if _, err := client.UpsertDashboard(ctx, folder, dashboard); err != nil {
		log.Fatalf("could not create dashboard: %v\n", err)
	}
}
