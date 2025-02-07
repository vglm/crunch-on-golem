import os
from time import sleep

import requests
import glob

# Configuration
FOLDER_PATH = 'output'  # Path to the folder containing the CSV files
API_URL = 'https://addressology.ovh/api/fancy/new_many'  # API endpoint URL

def upload_file(salt, address, factory, version):
    """Uploads a file to the specified API endpoint."""
    response = requests.post(API_URL, json={'salt': salt, 'address': address, 'factory': factory, 'miner': version})
    if response.status_code == 200:
        print(f"Successfully uploaded {address}")
        return True
    else:
        print(f"Failed to upload {address}. Status code: {response.status_code}")
        return False

def upload_many_to_serv(upload_many):
    """Uploads a file to the specified API endpoint."""
    json_array = []
    addresses = []
    for salt, address, factory, version in upload_many:
        json_array.append({'salt': salt, 'address': address, 'factory': factory, 'miner': version})
        addresses.append(address)
    response = requests.post(API_URL, json=json_array)
    if response.status_code == 200:
        print("Successfully uploaded {} - {}".format(addresses, response.json()['totalScore']))
        return True
    else:
        print(f"Failed to upload {address}. Status code: {response.status_code}")
        return False

def main():
    while True:
        try:

            # Get all CSV files in the folder with the naming pattern addr_1_2.csv
            csv_files = glob.glob(os.path.join(FOLDER_PATH, 'addr_*.csv'))
            csv_files = csv_files[0:50]
            upload_many = []
            if not csv_files:
                print("No CSV files found in the specified folder.")
            else:
                for csv_file in csv_files:
                    with open(csv_file, 'r') as f:
                        data = f.read()

                    salt = data.split(',')[0]
                    address = data.split(',')[1]
                    factory = data.split(',')[2]
                    version = data.split(',')[3]

                    upload_many.append((salt, address, factory, version))
            if upload_many and upload_many_to_serv(upload_many):
                # If the upload was successful, delete the file
                for csv_file in csv_files:
                    os.remove(csv_file)
                continue
        except Exception as e:
            print(f"An error occurred: {e}")

        sleep(5)

if __name__ == "__main__":
    main()