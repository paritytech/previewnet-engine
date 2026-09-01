# install.sh - Install system dependencies for PPN
#

# Check for protoc (only needed if building from source)
if ! command -v protoc &> /dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install protobuf
    else
        sudo apt install -y protobuf-compiler
    fi
fi

